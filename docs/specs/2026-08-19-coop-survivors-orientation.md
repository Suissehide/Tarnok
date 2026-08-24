# Tarnok — orientation

Document d'orientation, pas une spec exécutable. Il fixe le périmètre, les choix
d'architecture et les décisions déjà tranchées, pour que les specs qui en découlent
n'aient pas à les rejouer. Chaque étape du §13 aura sa propre spec, son propre plan et sa
propre livraison.

Statut : **brouillon d'orientation, révision 4**. Le nom et le thème sont arrêtés
(§1.1), et avec eux les six éléments. Plus aucune décision bloquante : le §15 ne contient
que des réglages à faire au moment de les aborder.

---

## 1. Intention

Un bullet heaven jouable **à 1-4 joueurs en ligne**, dans la filiation de *Vampire
Survivors* et surtout de *Swarm* (League of Legends), mais dont la coopération n'est pas
un habillage : le jeu doit être **meilleur à plusieurs qu'en solo**, et pour des raisons
mécaniques, pas sociales.

Trois piliers portent cette ambition, et rien d'autre dans ce document n'a la priorité
sur eux :

1. **Les réactions élémentaires entre joueurs.** Chaque arme applique un élément ; c'est
   la rencontre de deux éléments sur un même ennemi qui produit l'effet intéressant. Un
   joueur seul ne peut pas couvrir assez d'éléments pour tout déclencher lui-même. La
   coopération devient la source principale de puissance, et elle est *visible*.
2. **L'étalage commun à conflits.** À chaque niveau, un seul étalage de cartes pour toute
   l'équipe, choix simultanés, conflits arbitrés. Chaque montée de niveau est une
   négociation de vingt secondes.
3. **Le vote d'extraction.** Après chaque boss, l'équipe choisit collectivement : partir
   avec l'or, ou continuer et risquer de tout perdre. C'est le moment dont les joueurs
   parlent après la partie.

Le contre-modèle à éviter est explicite : un jeu où quatre joueurs jouent quatre parties
solo côte à côte sur la même carte. Le §8 est entièrement consacré à l'empêcher.

### 1.1 Nom et thème

**Le jeu s'appelle Tarnok.** Nom inventé, sans collision sur Steam ni sur itch. Un
homonyme existe — Tárnok, un village hongrois d'origine slave — sans conséquence, sinon
que les recherches web le renverront.

**La fiction : des chevaliers, une forge, des hordes.** Quatre combattants tiennent une
position contre une marée de monstres. Leurs armes se trempent, s'allient et se
combinent ; ce qu'ils arrachent à la horde se compte en métal, et l'extraction (§9.3)
consiste à le ramener avant d'être submergé.

Ce thème n'est pas une couche de peinture, il produit trois choses concrètes : les six
éléments du §6.3, qui sont un arsenal de siège crédible plutôt qu'un « feu, glace,
foudre » générique ; la contrainte de palette sombre du §6.6, que la forge satisfait
naturellement — métal noir, braise, suie ; et le vocabulaire de l'interface, qui a
désormais un registre.

### Ce que le jeu n'est pas

Ce n'est pas InkPoint. Pas d'arène fixe, pas de simulation déterministe partagée, pas de
caméra unique. Les conventions de dépôt, la stack et la discipline de tests d'InkPoint
sont reprises (§12) ; son architecture ne l'est pas, et le §3 explique pourquoi.

---

## 2. Le jeu en une page

**Format.** 1 à 4 joueurs, salon privé rejoint par code. Carte immense parcourue
librement, **une caméra par joueur**. **Vue de dessus légèrement écrasée** — projection
arbitrée au §4.5.

**Départ.** Tout le monde commence avec **la même arme neutre de base**, faible et sans
élément. Aucune arme signature, aucun élément imposé par la classe : l'identité
élémentaire de chaque joueur se construit intégralement au draft, ce qui fait du premier
étalage le moment structurant de la run (§7.1).

**Boucle de run.**

- Les ennemis arrivent par vagues data-driven. Ils meurent en une à trois touches et
  lâchent des orbes d'expérience.
- **L'expérience est globale** : ce qu'un joueur ramasse fait monter toute l'équipe, en
  même temps.
- À chaque niveau, **le monde et le chronomètre se figent** et l'étalage commun s'ouvre
  (§7). Chacun repart avec une carte — arme, passif, ou amélioration d'arme.
- Une **vague de boss toutes les quatre vagues**. Le boss vaincu ouvre un portail
  d'extraction pendant vingt secondes : le **vote** (§9).
- Entre les vagues, des **événements bonus** à objectif coopératif (§10) accordent un
  étalage supplémentaire.
- Pas de boss final. Pas de fin. **Le score, c'est le palier atteint.**

**Boucle méta.** L'or ramassé n'est acquis qu'après extraction. Il achète des
améliorations permanentes et des déblocages entre les parties (§11).

**Cible de session.** 20 à 30 minutes, soit quatre à six paliers de boss, donc quatre à
six votes d'extraction.

---

## 3. Architecture réseau

### 3.1 La décision

**Serveur autoritaire, transport WebSocket, pas de simulation déterministe partagée.**

C'est un écart assumé vis-à-vis d'InkPoint, dont le noyau `sim/` est déterministe au bit
près entre moteurs JavaScript. Ce déterminisme aurait rendu possible un lockstep — on
n'échange que les entrées, la bande passante devient négligeable. Il a été écarté pour
trois raisons :

- **Le coût de la garantie.** InkPoint a dû se doter d'un `sim/math.ts` en polynômes
  minimax, d'un fichier doré de valeurs épinglées au bit et d'une CI qui rejoue tout sous
  Chromium, Firefox et WebKit. Chaque nouvelle arme, chaque nouvel ennemi retombe sous
  cette contrainte, à vie.
- **La vitesse du plus lent.** En lockstep, la partie avance au rythme de la machine la
  plus faible. Avec quatre joueurs, une carte immense et des centaines d'entités, c'est
  une loterie.
- **L'or persistant.** La méta-progression donne une valeur réelle à ce qui se passe
  pendant la run. Le serveur doit posséder cette valeur, pas l'accepter d'un client.

En échange, la bande passante devient le budget central du projet — et le §3.3 est la
réponse à ce coût.

### 3.2 Le précédent qui valide, et celui qui alerte

Riot écrit dans son post-mortem technique que « League of Legends est un jeu
serveur-autoritaire sur serveurs dédiés, **un paradigme qui ne se prête pas très bien à
un mode bullet-heaven comme Swarm** ». Ils l'ont fait quand même, parce qu'ils héritaient
de l'engine. Nous partons de zéro, donc nous gardons l'autorité serveur *et* nous
contournons ce qui la rend chère.

Trois chiffres de ce post-mortem sont à garder sous les yeux pendant tout le projet :

| Mesure | Valeur chez Riot | Ce que ça implique ici |
| --- | --- | --- |
| Sbires simultanés | **~550**, pics vers 1 000 | La cible de 5 000 entités était fantasmée. Voir §4.1 |
| Bande passante 4 joueurs vs 1 | **~8×** | La croissance est superlinéaire, à surveiller dès le prototype |
| Plafond par machine | **~200 parties**, limité par l'overhead des **threads réseau**, ni le CPU ni la RAM | La métrique à instrumenter en premier n'est pas le temps de simulation |

*The Spell Brigade* (1-4 joueurs en ligne, sorti en 2025) est la référence la plus proche
et documente le compromis retenu ici : prédiction client sur le **déplacement des
ennemis**, sorts possédés par le client mais **dégâts et impacts arbitrés par le
serveur**, et ciblage déterministe pour que l'auto-visée désigne le même ennemi sur tous
les postes.

### 3.3 Le principe : on ne réplique pas la horde, on réplique son générateur

C'est la décision technique structurante du projet.

La piétaille a une intelligence triviale — aller vers le joueur le plus proche. Si tous
les clients reçoivent la même **graine de vague** et les **quatre positions de joueurs**
(seules entités réellement répliquées), ils recalculent la même horde localement sans
qu'un seul octet de position de monstre ne transite.

Et cette simulation locale **n'a pas besoin d'être exacte, seulement ressemblante**.
C'est toute la différence avec le lockstep : une divergence de trois pixels sur un
monstre qui vit deux secondes est invisible, parce que le serveur arbitre sa mort et ses
dégâts.

| Objet | Autorité | Ce qui passe sur le fil | Rôle du client |
| --- | --- | --- | --- |
| Les 4 joueurs | serveur | 20-25 Hz, delta binaire | prédit le sien, interpole les autres |
| Ordre de vague | serveur | **1 message** : graine, archétype, formation, ancre, tick | instancie et simule en local |
| Piétaille | serveur (flowfield) | **aucune position** — uniquement les morts, groupées par tick | recalcule le même flowfield |
| Élites et boss | serveur | 20 Hz, 1 à 20 entités | interpole |
| Projectiles | serveur pour les dégâts | 1 événement de tir : arme, direction, tick | génère les projectiles localement |
| Orbes, or, niveau, draft | serveur | événements | prédit le ramassage, corrige |

**Estimation de bande passante avec cette répartition : 5 à 15 ko/s par joueur.** À
comparer aux ~3 Mo/s d'une réplication naïve de 5 000 entités à 60 Hz. Cette estimation
est à valider par l'étape 1 du §13, elle n'est pas mesurée.

### 3.4 Le point de friction, et sa règle

Le seul endroit où la divergence entre la horde locale et la horde serveur devient
visible, c'est **le contact entre un ennemi et un joueur** — c'est le seul moment où la
position d'un monstre a une conséquence irréversible.

Règle : **le serveur tranche, la hitbox du joueur est généreuse, et l'arbitrage penche
systématiquement en faveur du joueur.** Un coup encaissé qu'on n'a pas vu venir est
mémorable et rageant ; un coup évité de justesse qu'on aurait dû prendre ne se remarque
pas. L'asymétrie est délibérée.

### 3.5 Cadences

| Boucle | Fréquence | Note |
| --- | --- | --- |
| Simulation serveur | 30 Hz | à valider ; 20 Hz possible si la sensation tient |
| Diffusion serveur → clients | 15-20 Hz | une seule trame binaire groupée par joueur et par tick |
| Rendu client | 60 fps | interpolation ~100 ms sur les entités répliquées |
| Entrées client → serveur | 30 Hz | prédiction locale immédiate du déplacement propre |
| Recalcul du flowfield | 5-10 Hz | une passe par joueur, quatre champs au maximum |

### 3.6 Format de trame

Binaire, jamais de JSON sur la boucle de jeu. Positions quantifiées en `int16` dans
l'espace de la carte, identifiants d'entité sur 16 bits, un seul `send` par joueur et par
tick. Le JSON reste acceptable hors boucle de jeu : salons, authentification,
méta-progression.

### 3.7 Reconnexion

Bien plus simple qu'en lockstep : le serveur possède l'état, il envoie un instantané
complet de la zone d'intérêt du joueur qui revient, plus l'état de son build. Aucun rejeu
d'entrées. Fenêtre de reconnexion à fixer — proposition : 90 secondes, après quoi le
personnage est retiré et le scaling recalculé sur le nombre de joueurs restants.

---

## 4. Performance

### 4.1 Recalibrer la cible

**Cible : 800 à 1 500 entités actives, tous joueurs confondus.** Pas 5 000.

C'est l'ordre de grandeur de *Swarm* (~550, pics vers 1 000), avec derrière lui un moteur
C++ mature et une équipe dédiée. La sensation de masse se fabrique par des **formations
denses de chair à canon qui meurt en une touche** et par un rendu qui exagère — pas par
un compteur.

> **Mesuré à l'étape 1, le 24 août 2026** — voir
> [`../plans/2026-08-24-banc-resultats.md`](../plans/2026-08-24-banc-resultats.md).
>
> **4 000 entités tiennent un pas de simulation en 0,87 ms de p95, sans atteindre la
> limite** (budget : 11 ms). Le nombre d'entités n'est pas le facteur limitant : de 250 à
> 4 000, le coût d'un pas passe de 0,84 à 0,87 ms, parce que le flowfield coûte
> `O(cellules)` et non `O(ennemis)`. Le coût réel est celui des champs — 23 ns par cellule
> visitée — et il fixe la taille de carte, pas la densité. La cible de 800 à 1 500 tient
> donc telle quelle, et le scaling ×N du §5 avec elle.
>
> Réserve, et elle est importante : le banc ne mesure que le flowfield et le déplacement.
> Ni séparation entre entités, ni collisions, ni dégâts, ni zone d'intérêt — **aucun de ces
> systèmes n'existe encore**, et ce sont eux qui scalent mal avec N. Le chiffre ci-dessus
> dit que l'architecture n'a pas de défaut rédhibitoire, pas qu'on tiendra 1 500 entités
> une fois le jeu écrit. À rejouer à la fin des étapes 2 et 3.
>
> Mesuré sur une machine trop rapide (Apple M5 Pro). La colonne « machine faible » du
> tableau de résultats est **à remplir avant l'étape 3**.

### 4.2 Le flowfield, dès le premier prototype

C'est l'enseignement principal du post-mortem de Riot : leur pathfinding A\* par agent
**scalait quadratiquement** avec le nombre de sbires. Ils l'ont remplacé par une carte de
Dijkstra / flowfield — un coût propagé sur une grille, chaque agent lisant le gradient de
sa cellule.

Ici : une grille de coût sur la carte (cellules d'environ 64 px), **une passe par
joueur**, donc quatre champs au maximum, recalculée 5 à 10 fois par seconde. Coût en
`O(cellules)` au lieu de `O(ennemis × longueur du chemin)`.

Bénéfice secondaire décisif : **le champ se réplique gratuitement**, puisque le client le
recalcule à partir des quatre positions de joueurs qu'il reçoit déjà. C'est ce qui rend
le §3.3 possible.

### 4.3 Rendu — le danger est le VFX, pas les sprites

Chez Riot, le goulot client n'était pas le nombre d'entités mais **les particules, à 34 ms
par frame**. Deux conséquences directes en PixiJS v8 :

- **Ne pas instancier 1 500 objets `Sprite`.** Le GPU se moque de 1 500 quads ; ce qui
  tue, c'est le coût JavaScript par objet et par transform. Un `ParticleContainer` (ou un
  mesh instancié custom), un `Float32Array` de positions rempli à chaque frame, un seul
  atlas de textures pour tout ce qui est massif.
- **Un budget de particules chiffré et un compteur en debug dès la première semaine**,
  avec dégradation automatique — un LOD de VFX qui coupe les effets secondaires quand le
  budget est dépassé. Riot a perdu 34 ms/frame là-dessus *avec* une équipe moteur.
- **Les états élémentaires ne coûtent presque rien si on les encode bien** : la teinte par
  sprite est gratuite à l'intérieur du batch, les zones au sol sont quelques dizaines de
  grands quads, et seul l'anneau bicolore ajoute un quad par ennemi concerné. Le détail
  est au §6.6, mais c'est un choix de rendu autant qu'un choix de design.

### 4.4 Batching des effets

Autre leçon volée à Riot : les buffs étaient le poste le plus coûteux de leur prototype,
et la solution a été de **les appliquer par lots via des proxies réutilisables** plutôt
qu'une instance par ennemi. Ici, les états élémentaires (§6) sont exactement ce risque :
1 500 ennemis × plusieurs états × un timer chacun. Les états doivent être des **champs de
bits et des timers dans des tableaux typés**, jamais des objets.

### 4.5 Projection : vue de dessus, pas isométrique

**Décision : vue de dessus, très légèrement écrasée en hauteur (facteur ~0,82).**
L'isométrique a été prototypée et écartée sur pièces — `docs/maquettes/rendu.html`
permet de basculer entre les deux sur la même scène.

Trois raisons, dans l'ordre d'importance :

- **La densité.** En isométrique, un sprite debout masque ce qui est derrière lui. À 800
  ennemis la horde perd sa lisibilité de masse bien avant d'atteindre la cible du §4.1 —
  or cette masse *est* le genre. La vue de dessus encaisse la même densité sans occlusion
  significative.
- **La zone d'intérêt (§3.3).** En vue de dessus, la fenêtre visible d'un joueur est un
  **rectangle aligné sur les axes du monde**, donc le filtrage d'entités et la grille de
  flowfield (§4.2) se requêtent en `O(1)` par cellule. En isométrique, ce même rectangle
  écran devient un losange en coordonnées monde : chaque requête d'intérêt se complique,
  pour rien.
- **L'art.** Les tilesets de type *Tiny Swords* sont peints pour une caméra de face. Passés
  en isométrique, leurs textures horizontales produisent un moirage diagonal très visible
  et les découpes de terrain prennent des angles mécaniques. Un vrai tileset isométrique
  existe, mais il s'achète et il contraint tout l'art à venir.

Ce que l'isométrique aurait apporté — de la profondeur perçue — est justement ce dont un
bullet heaven n'a pas besoin : ici, le sol est une surface de jeu, pas un décor.

**Conséquence sur le tri.** Le tri en profondeur par `y` reste nécessaire pour que les
chevauchements soient corrects, mais il devient un simple tri par tranches horizontales
plutôt qu'un tri global par `x+y`. À la cible de 1 500 entités, c'est la différence entre
un `sort()` complet par frame et un rangement en compartiments — à mesurer à l'étape 1.

### 4.6 Ce qu'il faut instrumenter dès le jour un

- `octets/tick` et `µs passées à sérialiser et envoyer`, par salon — la métrique qui a
  plafonné Riot.
- `ms de simulation/tick`, ventilées par système.
- Compteur d'entités actives, compteur de particules.
- Un HUD de debug serveur, pas des logs.

---

## 5. Scaling par nombre de joueurs

Une seule règle porte tout le reste : **on scale la densité, pas les statistiques.**

Gonfler les points de vie des ennemis fait sentir chaque joueur *plus faible* quand
l'équipe s'agrandit — c'est le défaut connu des parties à quatre de *Risk of Rain 2*, où
le contenu finit en sacs à points de vie et où plus personne ne sent son build. Le
fantasme du genre est la masse, pas l'éponge.

| Grandeur | Règle | Justification |
| --- | --- | --- |
| Nombre d'ennemis | **×N** | C'est le fantasme du genre |
| Points de vie des ennemis | ×1, ou ×1,15^(N−1) au maximum | Voir ci-dessus |
| Points de vie des boss | ~×N | Sinon il fond en quelques secondes |
| Courbe d'expérience | **×N** | **Sans ça : 4× plus de niveaux, donc 4× plus de gels.** Voir §7.4 |
| Or récolté | ×N ; coûts méta inchangés | La méta ne doit pas dépendre de la taille du groupe |
| Objectifs d'événement | dimensionnés sur N (3 sceaux à 4 joueurs, 2 à 2) | Voir §10 |
| Cadence des vagues | inchangée | Le rythme du jeu est le rythme du jeu |
| Taille de l'étalage | **N + 3** | Voir §7.2 |

Le scaling est recalculé si un joueur quitte ou est déconnecté au-delà de la fenêtre de
reconnexion (§3.7).

---

## 6. Armes, passifs, éléments et réactions

### 6.1 Les slots

| Catégorie | Nombre | Note |
| --- | --- | --- |
| Arme de base neutre | 1 | commune à tous, **hors slots**, reste faible toute la partie |
| Armes | 5 | **toutes draftées**, aucune n'est attribuée d'avance |
| Passifs | 3, extensibles à 6 | slots débloqués par événements bonus et paliers de boss |

Format repris de *Swarm*, qui l'a éprouvé, à une exception près : **il n'y a pas d'arme
signature.** Chez *Swarm*, le champion apporte sa première arme ; ici, la classe
n'apporte qu'un verbe et un trait (§6.7), jamais un élément.

Ce n'est pas un détail. Une classe qui fixerait l'élément de départ entrerait en conflit
frontal avec l'exclusivité des armes (§6.2) et retirerait au draft ce qui en fait le cœur
du jeu. L'arme neutre de base existe pour la même raison : elle garantit qu'on peut
toujours tirer, sans jamais orienter le build.

### 6.2 Exclusivité des armes

**Une arme, un porteur.** Si un joueur prend le Lance-flammes, il sort du pool de
l'équipe pour toute la run — pas « moins de chances de l'obtenir », plus du tout.

C'est délibérément binaire, et c'est un rejet du modèle probabiliste de TFT. Le pool de
TFT fonctionne parce que le joueur *peut le compter* : il a une boutique, du temps, une
communauté qui a écrit les tables. Dans un jeu d'action de 25 minutes, « tu as 18 % de
chances au lieu de 25 % » ne sera jamais perçu par personne. **Une mécanique
imperceptible n'est pas une mécanique.**

Conséquences :

- 4 joueurs × 5 armes = **20 armes distinctes tirées par run**, donc le pool doit compter
  **au moins 40 armes** pour que deux parties ne se ressemblent pas.
- Les **passifs restent dupliquables** entre joueurs. Les rendre exclusifs aussi serait
  punitif et rendrait les builds impossibles à finir.

### 6.3 Les six éléments

Le modèle est celui des réactions élémentaires de *Genshin Impact*, et non un système
« poseur / détonateur » à deux camps : **chaque arme applique un élément, et c'est
l'application d'un *second* élément différent sur un ennemi déjà affecté qui déclenche
une réaction.** Six éléments produisent quinze réactions distinctes — beaucoup de contenu
à partir de peu de pièces, ce qui est exactement ce qu'exige un pool de 40 armes.

Les six éléments sont un **arsenal de siège médiéval**, pas une liste générique : la poix
et la chaux vive sont de vraies armes de siège, le vif-argent apporte la part alchimique.

| Élément | Effet seul |
| --- | --- |
| **Braise** | dégâts sur la durée |
| **Givre** | ralentit ; gèle sur accumulation |
| **Foudre** | chaîne vers quelques ennemis proches |
| **Poix** | englue, ralentit, amplifie les dégâts reçus |
| **Chaux** | corrode : réduit l'armure et brouille le ciblage de l'ennemi |
| **Vif-argent** | lie entre eux les ennemis proches et attire les projectiles |

Répartition visée sur 40 armes : **six à sept armes par élément, plus quatre à six armes
neutres** à dégâts bruts, qui servent de filet pour les débuts de run et de socle pour
les joueurs qui ne veulent pas jouer le système.

**Les éléments s'appliquent au sol autant qu'aux ennemis.** La Poix est une flaque, la
Braise une zone qui brûle, le Givre une plaque, la Chaux un voile corrosif. Une
réaction se déclenche donc de deux façons : un ennemi déjà affecté reçoit un second
élément, **ou deux zones au sol se recouvrent**.

C'est une décision de design autant que de rendu, et elle gagne sur trois tableaux à la
fois — lisibilité (§6.6), coût de rendu (§4.3) et regroupement (§8). Elle introduit en
prime du placement habile dans un genre qui en manque.

### 6.4 Les quinze réactions

| Paire | Nom | Effet |
| --- | --- | --- |
| Braise + Givre | **Choc thermique** | dégâts bruts massifs sur une cible, brise l'armure |
| Braise + Foudre | **Surchauffe** | zone brûlante persistante au sol |
| Braise + Poix | **Embrasement** | explosion qui se propage à tous les ennemis poissés proches |
| Braise + Chaux | **Fournée** | la calcination double le dégât sur la durée et ignore l'armure |
| Braise + Vif-argent | **Vaporisation** | nuage toxique qui suit les ennemis liés |
| Givre + Foudre | **Supraconduction** | gel immédiat, et armure réduite pour toute la zone |
| Givre + Poix | **Verglas** | flaque glissante : les ennemis dérapent et se percutent |
| Givre + Chaux | **Éclat de gel** | la chaux fissure, le givre brise : la cible explose en éclats |
| Givre + Vif-argent | **Gel profond** | le métal conduit le froid : tous les ennemis liés gèlent |
| Foudre + Poix | **Court-circuit** | la chaîne se propage sans limite de sauts entre ennemis poissés |
| Foudre + Chaux | **Arc caustique** | la chaîne laisse une traînée corrosive au sol |
| Foudre + Vif-argent | **Paratonnerre** | la cible attire toutes les chaînes de la zone |
| Poix + Chaux | **Mortier vif** | le mélange durcit : les ennemis sont scellés sur place |
| Poix + Vif-argent | **Amalgame** | les ennemis proches sont collés ensemble et partagent les dégâts |
| Chaux + Vif-argent | **Aveuglement** | les ennemis perdent leur cible et errent |

*Amalgame* et *Mortier vif* sont volontairement des outils de regroupement et
d'immobilisation : dans un bullet heaven, rassembler la horde est une action offensive.

Ces effets sont des intentions de design, pas des valeurs équilibrées. Le passage aux
chiffres appartient à la spec de l'étape 5 (§13).

### 6.5 Le compteur de Synergie — la pièce maîtresse

**Quand une réaction est déclenchée par deux joueurs différents — l'un a appliqué le
premier élément, l'autre le second — l'équipe gagne une charge de Synergie. Déclenchée en
solo, la même réaction ne rapporte rien.**

Les charges remplissent une barre commune affichée dans le HUD de tout le monde. Pleine,
**n'importe qui peut déclencher l'ultime d'équipe**, qui profite à tous.

C'est le cœur du projet, pour quatre raisons :

- La coopération devient une **ressource visible et audible**, pas une vertu abstraite.
- Elle ne se charge que si les joueurs sont **dans la même mêlée** : c'est un outil de
  regroupement qui fonctionne par le gain, jamais par la punition.
- Elle crée la tension de build la plus intéressante du jeu : **se spécialiser sur un
  élément est plus puissant, mais seulement si quelqu'un d'autre couvre le complément.**
  Un joueur qui se diversifie pour être autonome se prive du multiplicateur d'équipe.
  C'est exactement l'incitation qu'on cherche.
- Combinée à l'exclusivité (§6.2), elle transforme le draft en puzzle collectif : à 20
  armes tirées sur six éléments, une équipe *ne peut pas* tout couvrir.

### 6.6 Lisibilité des états élémentaires

C'est le problème visuel le plus difficile du projet, et il découle directement de la
mécanique : il faut **six couleurs saturées distinguables sur des sprites minuscules**,
plus leurs quinze combinaisons, à 1 500 entités.

**Conséquence non négociable : l'environnement doit être sombre et désaturé.** C'est une
contrainte technique, pas une préférence esthétique, et elle découle du thème arrêté au §1.1 — un décor clair et coloré rend le système illisible quelle que soit la
qualité du dessin.

Hiérarchie d'encodage retenue :

| Ce qu'il faut montrer | Encodage | Coût |
| --- | --- | --- |
| Zone élémentaire au sol | grand quad teinté, additif | quelques dizaines de quads |
| Un élément sur un ennemi | **teinte du sprite** — gratuite dans le batch Pixi | 0 |
| Deux éléments, avant réaction | **anneau au sol bicolore** sous l'ennemi, second `ParticleContainer` | 1 quad par ennemi concerné |
| La réaction | **flash court, large, généreux** | c'est là que passe le budget VFX |
| Identité des joueurs | anneau coloré sous chaque joueur | 4 quads |

La règle qui évite la bouillie : **l'état persistant est discret, la réaction est
spectaculaire.** Si 1 500 ennemis brillent en permanence, plus rien ne se lit — et le
budget de particules du §4.3 est consommé par du bruit de fond au lieu de l'être par les
moments qui comptent.

L'anneau sous les joueurs répond à un besoin distinct : avec quatre caméras indépendantes
sur une carte immense, il faut identifier qui est qui d'un seul coup d'œil.

### 6.7 Les classes

**Une classe apporte un verbe et un trait passif. Jamais un élément, jamais une arme.**

Le verbe est une capacité active à temps de recharge. Au moins la moitié des verbes doit
être **tournée vers l'équipe**, sans quoi on obtient quatre variantes de « je fais des
dégâts ».

| Verbe | Effet | Ce qu'il résout |
| --- | --- | --- |
| **Appel** | aspire les ennemis vers un point | crée les conditions des réactions |
| **Relais** | se téléporte vers un allié, ou l'attire à soi | répond au problème de la carte immense |
| **Amorce** | applique en zone l'élément de ton arme principale, sans dégâts | le poseur pur — inutile seul, décisif à deux |
| **Écho** | rejoue la dernière réaction déclenchée par un allié | ne fonctionne littéralement pas en solo |
| **Rempart** | zone où les alliés encaissent moins | le seul rôle défensif |
| **Fracture** | consomme la barre de Synergie pour un dégât immédiat | usage alternatif de la ressource commune |

Le choix des personnages en salon devient ainsi une première négociation — sur les
verbes, sujet plus léger et plus lisible qu'un écran de sélection — et la négociation
lourde, celle des éléments, se joue au premier étalage (§7.1).

Quatre classes au lancement, deux ou trois débloquables à l'or (§11). Nombre et verbes
exacts : §15.1.

---

## 7. Le draft — l'étalage commun à conflits

### 7.1 Le principe

À chaque montée de niveau, **le monde et le chronomètre se figent** et **un seul étalage
de cartes s'ouvre pour toute l'équipe**. Chacun choisit en simultané. Les conflits sont
révélés et arbitrés à la fermeture.

C'est le pari de design du projet en matière d'interface : faire d'un écran de menu le
moment le plus social de la partie. *« Touche pas au givre, je le prends. »*

**Le premier étalage est le moment structurant de la run.** Puisque personne ne démarre
avec un élément (§2), c'est là — et nulle part ailleurs — que l'équipe se répartit les
six éléments, avec l'exclusivité qui mord déjà et les enjeux entièrement lisibles. Si un
seul écran du jeu doit être excellent, c'est celui-là.

### 7.2 Déroulé

1. Le serveur tire **N + 3 cartes** (2 joueurs → 5 cartes ; 4 joueurs → 7). L'étalage
   exclut les armes déjà portées par un membre de l'équipe (§6.2).
2. Fenêtre de **20 secondes**, plafonnée. Chacun sélectionne sa carte.
3. **Les intentions des autres sont visibles en temps réel** : l'avatar de chaque joueur
   apparaît sur la carte qu'il survole. C'est ce qui crée la négociation — sans cette
   visibilité, la mécanique n'existe pas.
4. À la fermeture, si deux joueurs ont retenu la même carte, la **priorité** tranche. Le
   perdant repioche parmi ce qui reste, avec **5 secondes supplémentaires**.
5. La priorité **tourne** : le perdant d'un conflit est prioritaire au niveau suivant.
   Personne ne perd deux fois de suite.
6. Sur expiration du délai, une carte est attribuée automatiquement selon un score
   simple. Un joueur absent ne bloque jamais la partie.

Le serveur possède le tirage, les intentions et l'arbitrage. Aucun client ne décide de
quoi que ce soit ici.

### 7.3 Le risque, assumé et borné

C'est une mécanique qui divise : perdre une carte au profit d'un allié peut être vécu
comme une frustration plutôt que comme un moment de jeu. Deux garde-fous, et un plan de
repli :

- La **rotation de priorité** (point 5) garantit qu'aucun joueur ne subit
  structurellement.
- Le **repioche immédiat** évite le sentiment de tour perdu.
- **Plan de repli, à décider après playtest** : bascule vers le modèle *3 cartes privées
  + 1 carte d'équipe convoitée* — chacun garde un tirage personnel de trois cartes sans
  conflit possible, et une seule carte commune, visible de tous, qu'un seul peut
  réclamer. Un moment social par niveau, zéro frustration sur le build personnel. Ce
  modèle doit rester implémentable sans refonte : **le protocole de draft est conçu pour
  supporter les deux.**

### 7.4 Le piège du gel

Avec une expérience globale et quatre joueurs, on monte de niveau environ quatre fois
plus vite qu'en solo. Sans correction, la partie passe **un tiers de son temps figée**.

C'est pour cela que la courbe d'expérience est multipliée par N au §5, et ce n'est pas un
réglage d'équilibrage tardif : c'est une condition de jouabilité, à poser dans la toute
première version du draft.

*Swarm* fige lui aussi le jeu et le chronomètre au niveau, avec un plafond de **30
secondes** et une reprise progressive sur une seconde. Le plafond de 20 secondes retenu
ici est plus serré parce que l'étalage commun ajoute une phase de conflit ; la reprise
progressive est reprise telle quelle, elle évite de se faire toucher à la reprise.

### 7.5 Contenu des cartes

Trois natures dans le même étalage : **une arme nouvelle**, **un niveau d'arme possédée**,
**un passif**. Une arme au niveau maximum peut se voir proposer son **évolution**, à
condition que le joueur possède au moins un niveau du passif associé — mécanique
directement reprise de *Swarm*.

---

## 8. Le co-op : favoriser le regroupement

Le problème est structurel et il faut le nommer : **expérience globale + caméra par
joueur + carte immense = se séparer est optimal.** Deux joueurs qui couvrent deux zones
ramassent deux fois plus pour tout le monde. Sans contre-mesure, le jeu pousse
mécaniquement les gens à ne jamais se voir.

Les sept leviers ci-dessous sont classés par efficacité attendue.

| # | Levier | Nature |
| --- | --- | --- |
| 1 | **La Synergie** (§6.5) ne se charge qu'à plusieurs, dans la même mêlée | gain |
| 2 | **Densité de spawn par grappe** : le taux d'apparition se calcule par groupe de joueurs proches, pas globalement. Groupés = beaucoup plus d'ennemis à l'écran, donc plus d'expérience par minute *et* plus de danger | pari rentable |
| 3 | **Les boss** (§9) : points de vie et fenêtre d'enrage calibrés pour exiger le dégât de l'équipe entière. Rester farmer au loin fait perdre le palier | contrainte de rythme |
| 4 | **Les événements bonus** (§10) : objectif exigeant au moins deux joueurs, récompense d'équipe | contrainte ponctuelle |
| 5 | **Réanimation de proximité** (§8.2) | contrainte ponctuelle |
| 6 | **Outillage social** : minimap, flèches vers les alliés en bord d'écran, roue de ping à quatre intentions — *viens*, *danger*, *boss*, *je prends* | outil |
| 7 | **Les zones élémentaires au sol** (§6.3) : une flaque d'huile allumée par quelqu'un d'autre donne une raison concrète de se battre au même endroit | gain |

Le levier 6 est le moins cher de tous et probablement le plus efficace : *Deep Rock
Galactic* tient une part considérable de sa réputation coopérative sur son outillage de
communication.

### 8.1 L'anti-pattern, explicitement interdit

**Aucune laisse, aucun malus de distance, aucun dégât si on s'éloigne.** Une punition se
lit comme un bug ; une incitation se lit comme du design. Le jeu doit rendre le
regroupement *rentable*, jamais *obligatoire*.

Même raisonnement pour le **friendly fire** : *The Spell Brigade* en a fait une identité
comique assumée, mais dans un jeu qui cherche le regroupement il produit exactement
l'inverse. **Décision : du recul, du désordre visuel, jamais de dégâts entre joueurs.**

### 8.2 Le mort n'attend pas

Le barème de *Swarm* — 10 secondes pour être relevé par un allié, sinon un respawn de 15
secondes **augmenté de 9 secondes par mort et plafonné à 60** — punit le plus durement le
joueur le plus faible, c'est-à-dire précisément celui qui est en train de décrocher.

Modèle retenu, à valider en playtest :

- **Fenêtre de réanimation** par un allié à proximité, autour de 10 secondes ; retour à
  50 % des points de vie avec quelques secondes d'invulnérabilité.
- Passé ce délai, **forme fantôme active** : le joueur continue à se déplacer, rapide et
  invulnérable, sans infliger de dégâts, mais il **ramasse l'expérience** et sa présence
  auprès d'un allié vivant **accélère sa propre résurrection**. Il reste utile, et le jeu
  le ramène vers son équipe.
- **Pas de pénalité de temps croissante.** Si un coût est nécessaire, il est prélevé sur
  le **pool d'expérience commun** : tout le monde paie un peu, personne ne regarde son
  écran.

---

## 9. Structure de run : vagues, boss infinis, extraction

### 9.1 Rythme

| Unité | Durée cible | Note |
| --- | --- | --- |
| Vague | ~60 s | data-driven : type, nombre, cadence, forme, ancre |
| Palier | 4 vagues + 1 boss ≈ 5 min | |
| Run | 20-30 min | soit 4 à 6 paliers, donc 4 à 6 votes |

Les vagues sont **pilotées par la donnée, pas par du script** — troisième leçon volée à
Riot, qui a déplacé son spawn de vagues du script vers du C++ data-driven pour tenir la
charge. Ici : des définitions typées dans le contenu partagé, exécutées par un système
unique.

### 9.2 Difficulté non bornée

Sans boss final, la difficulté doit être une **formule**, pas une table — sinon le
contenu s'épuise en trois soirées. Point de départ à ajuster, pour un palier `k` :

- nombre d'ennemis : `×(1 + 0,15 k)`
- points de vie : `×1,12^k`
- récompense en or : croissante avec `k`, ce qui nourrit directement la tension du §9.3

Les boss sont un **pool tournant assorti d'affixes** — régénérateur, scindeur, aura de
givre, invocateur — plutôt qu'une liste finie. Un affixe supplémentaire est tiré tous les
quelques paliers.

### 9.3 Le vote d'extraction

**L'or ramassé pendant la run n'est pas acquis. Il est *non sécurisé* jusqu'à
l'extraction.**

Après chaque boss vaincu, un portail s'ouvre **20 secondes** :

- **Partir** — tout l'or non sécurisé est définitivement acquis, majoré d'un bonus de
  palier. La run se termine.
- **Rester** — le multiplicateur sur l'or non sécurisé augmente, et le palier suivant
  commence.
- **Effacement total de l'équipe** — l'or non sécurisé est **perdu**. L'or déjà banké
  lors des runs précédentes n'est jamais touché.

Une équipe doit trancher, à quatre, en vingt secondes, pendant que la vague suivante
approche.

**Règles de décision et garde-fous :**

| Question | Décision v1 | Alternative à tester |
| --- | --- | --- |
| Comment tranche-t-on ? | **Majorité ; égalité = on continue** | Extraction individuelle autorisée — le scaling (§5) se recalcule tout seul, ce qui rend la variante mécaniquement propre mais socialement plus dure |
| La mort d'un seul joueur coûte-t-elle l'or ? | **Non.** Seul l'effacement complet de l'équipe fait perdre | — |
| Perd-on vraiment 100 % ? | **À régler.** Perdre 25 minutes d'or sans rien est un motif d'arrêt de jeu | Plancher de 10-20 % conservé, ou bonus de palier toujours payé même en cas d'effacement |

La troisième ligne est le principal risque de design de tout le document. Elle se tranche
en playtest, pas sur le papier — mais elle doit être **un paramètre**, pas une valeur en
dur.

---

## 10. Événements bonus

Un critère de tri, et un seul : **impossible à réussir seul.** Sinon ce n'est pas du
coopératif, c'est du remplissage.

**Récompense : un étalage supplémentaire** (§7), plus occasionnellement un slot de passif.

| Événement | Ce qu'il force |
| --- | --- |
| **Les trois sceaux** | tenir 3 zones simultanément 20 s — séparation puis regroupement |
| **La forge** | un joueur canalise immobile pendant que les autres tiennent la ligne 60 s |
| **Le convoi** | un objet qui n'avance que si quelqu'un l'accompagne |
| **La battue** | un élite qui fuit, à prendre en tenaille |
| **Le noir** | la carte s'éteint, un seul joueur porte la lampe |
| **Le marchand** | or d'équipe, un seul achat, minuteur court |

Le nombre d'objectifs se dimensionne sur N (§5). En solo, ces événements se dégradent en
variantes à objectif unique plutôt que de disparaître.

---

## 11. Méta-progression et comptes

L'or persistant **casse la décision d'InkPoint** de ne pas avoir de comptes (pseudo libre
en `localStorage`, aucune donnée personnelle). Une progression permanente exige une
identité stable, donc une vraie authentification et un serveur qui possède le solde.

Proposition, à confirmer : **compte anonyme par jeton persistant**, créé sans friction à
la première partie, **promouvable en compte e-mail** pour survivre à un changement
d'appareil. On garde l'entrée sans formulaire tout en ayant une identité réelle.

L'or achète des améliorations permanentes (statistiques de départ, slots, relances de
draft) et des déblocages : armes ajoutées au pool, et **classes supplémentaires** au-delà
des quatre de départ (§6.7).

**Anti-triche.** L'autorité serveur règle le cas principal : un client ne peut pas
fabriquer d'or. Elle ne règle pas l'assistance au jeu — visée automatique, esquive
assistée. En coopératif privé, c'est le problème de l'équipe et de personne d'autre.
**Cela ne le reste plus s'il existe un classement mondial** : à trancher au §15.

---

## 12. Stack et structure du dépôt

Conventions reprises d'InkPoint, qui les tient déjà de Gachapon : Biome épinglé sans
caret, husky + commitlint en Conventional Commits, Vitest, `tsc --noEmit`, deux images
Docker distinctes derrière Traefik.

```
shared/    protocole binaire, définitions de contenu, flowfield et déplacement
           de la piétaille — code partagé front/back, sans package.json propre
front/     client TypeScript : PixiJS v8 (WebGL), UI DOM en Tailwind, Vite
back/      serveur : Fastify (HTTP) + ws (jeu), Prisma + PostgreSQL
deploy/    compose.yaml Traefik, dokploy/, un Dockerfile par app
docs/      specs et plans
```

**Un `package.json` racine déclarant les workspaces est nécessaire** — même raison que sur
InkPoint : `shared/` est un frère de `front/` et de `back/`, jamais leur descendant, donc
seule une installation hoistée à la racine lui fournit une racine de résolution.

### 12.1 Une précision importante sur `shared/`

« Pas de `sim/` comme InkPoint » signifie **pas de simulation déterministe au bit près**,
pas **pas de code partagé**. Le §3.3 impose au contraire que le client sache simuler la
piétaille localement : le flowfield, le déplacement de base et les définitions de vagues
**doivent** vivre dans `shared/`.

La différence de nature est totale, et il faut la garder en tête pour ne pas
recréer accidentellement les contraintes d'InkPoint :

| | `sim/` d'InkPoint | `shared/` ici |
| --- | --- | --- |
| Garantie | reproduction **au bit près**, entre moteurs | **ressemblance** suffisante |
| Test de pureté | oui, bloquant | non |
| `Math.sin` interdit | oui | non |
| Qui fait foi | les deux, identiquement | le serveur, toujours |

### 12.2 Assets : ce qu'on dessine, ce qu'on génère

**Placeholder retenu pour les étapes 0 à 4 : Tiny Swords** (Pixel Frog). Grille 64×64,
animations à 10 fps, sources `.aseprite` fournies, et surtout **cinq variantes de couleur
de chaque unité déjà livrées** — un système de palette swap prêt à l'emploi, exactement
ce qu'exige l'encodage du §6.6.

Ce qui manque : quatre unités jouables et trois gobelins, là où une horde en demande huit
à douze silhouettes distinctes. L'*Enemy Pack* payant (~10 $, 18 personnages) comble le
trou pour un prototype.

> ⚠️ **Contrainte de licence, à traiter au premier commit.** L'usage commercial est
> autorisé et le crédit facultatif, mais **la redistribution est interdite, même après
> modification**. Pousser le pack dans un dépôt public *est* une redistribution. Donc :
> dépôt privé, ou assets hors dépôt (bucket, `.gitignore`) — décidé avant le premier
> `git add`, jamais après.

**Ce qui se génère par du code, et ne doit donc jamais être dessiné :** les variantes de
couleur (un sprite par unité, six palettes au shader), les zones élémentaires au sol, les
contours, traînées, impacts et ondes, le terrain (tileset plus bruit plus autotiling), et
toute la direction artistique de post-process — grain, vignette, dithering, courbe de
couleur.

**Ce qu'il faut réellement dessiner :** huit à douze silhouettes d'ennemis, quatre à six
personnages, une poignée de props. C'est peu, et c'est commandable à un illustrateur une
fois le jeu jouable.

La génération d'images par IA est écartée pour le pixel art animé : ni la cohérence de
silhouette entre frames, ni celle entre unités ne sont au rendez-vous, et le nettoyage
coûte plus cher que le dessin.

**Enfin, et c'est la règle qui compte : l'art placeholder ne choisit pas le thème.** On
prototype sur Tiny Swords quel que soit le rendu final retenu, et la direction
artistique se tranche à l'étape 5 — au moment où le §6.6 devient une contrainte concrète.

---

## 13. Découpage en étapes livrables

L'ordre est contraint. Chaque étape est vérifiable seule et fera l'objet de sa propre
spec au moment de l'aborder.

| Étape | Contenu | Livrable vérifiable seul |
| --- | --- | --- |
| **0** | Socle : dépôt, workspaces, CI, Biome/husky, salon WebSocket minimal | Deux clients connectés voient leurs carrés bouger, arbitrés serveur |
| **1** | **Banc de performance** headless (Node) et rendu (Pixi) | **Un chiffre** : combien d'entités à 30 Hz, combien de sprites à 60 fps, combien d'octets/tick |
| **2** | Horde : flowfield, vagues data-driven, réplication du générateur (§3.3), rendu batché | 1 000 ennemis convergent identiquement sur 4 clients, sans position sur le fil |
| **3** | Combat : armes, projectiles client, dégâts serveur, mort, expérience globale | Une run solo jouable de bout en bout |
| **4** | Draft : gel global, étalage commun à conflits, exclusivité | Quatre joueurs draftent, un conflit se résout, la priorité tourne |
| **5** | Éléments, zones au sol, réactions, compteur de Synergie, encodage visuel du §6.6 | Une réaction inter-joueurs charge la barre, une réaction solo non ; deux zones qui se recouvrent réagissent |
| **6** | Boss, paliers, difficulté non bornée, vote d'extraction, or | Une run infinie avec un vote qui engage réellement l'or |
| **7** | Méta : comptes, or persistant, améliorations, déblocages | L'or survit à la fermeture du navigateur |
| **8** | Événements bonus | Trois événements jouables, dimensionnés sur N |
| **9** | Salons, matchmaking, reconnexion, dégradation à la déconnexion | Un joueur coupe son wifi 30 s et revient dans la partie |

**L'étape 1 n'est pas un détour, c'est une porte.** Si le banc répond « 400 entités à 30
Hz sur un laptop moyen », alors la carte immense, le scaling ×N et la cible de 1 500
entités du §4.1 sont tous à revoir — et il vaut infiniment mieux l'apprendre en semaine
deux qu'en mois cinq.

---

## 14. Décisions déjà tranchées

| Sujet | Décision | Raison |
| --- | --- | --- |
| Nom | **Tarnok** | Inventé, libre sur Steam et itch (§1.1) |
| Thème | **Chevaliers, forge, hordes** | Produit les six éléments, la palette sombre et le registre d'interface (§1.1) |
| Modèle réseau | Serveur autoritaire, WebSocket binaire | L'or persistant exige que le serveur possède la vérité (§3.1) |
| Déterminisme | **Abandonné** | Coût de maintenance à vie, et vitesse du plus lent (§3.1) |
| Réplication de la horde | **Le générateur, pas les entités** | Seule façon de tenir la bande passante (§3.3) |
| Arbitrage des contacts | Serveur, hitbox généreuse, en faveur du joueur | Asymétrie perceptive délibérée (§3.4) |
| Pathfinding | Flowfield par joueur | L'A\* par agent scale quadratiquement (§4.2) |
| Cible d'entités | 800-1 500 actives | *Swarm* tourne à ~550 avec un moteur C++ (§4.1) |
| Scaling | Densité ×N, statistiques quasi inchangées | Sinon chaque joueur se sent plus faible à mesure que l'équipe grandit (§5) |
| Courbe d'expérience | ×N | Sans quoi la partie est figée un tiers du temps (§7.4) |
| Caméra | Une par joueur | Choix produit ; rend en prime la zone d'intérêt naturelle |
| Projection | **Vue de dessus, écrasée ~0,82. Pas d'isométrique** | Densité sans occlusion, zone d'intérêt rectangulaire, et l'art du genre est peint pour cette caméra (§4.5) |
| Expérience | Globale | Supprime toute compétition sur le loot |
| Level-up | Gel du monde et du chronomètre, 20 s plafonnées | Modèle *Swarm*, resserré pour la phase de conflit (§7.4) |
| Draft | Étalage commun, choix simultanés, conflits arbitrés | Le moment social du jeu (§7) |
| Armes | 5 slots, **exclusives à l'équipe** | Force la spécialisation, rend les réactions nécessaires (§6.2) |
| Arme signature | **Aucune** | Entrerait en conflit avec l'exclusivité et viderait le draft de son enjeu (§6.1) |
| Départ | Arme neutre commune, hors slots | Garantit de pouvoir tirer sans orienter le build (§6.1) |
| Classes | **Un verbe + un trait, jamais un élément** | L'identité élémentaire appartient au draft (§6.7) |
| Passifs | 3 → 6 slots, **dupliquables** | L'exclusivité y serait punitive (§6.2) |
| Pool d'armes | ≥ 40 | 20 armes tirées par run à 4 joueurs (§6.2) |
| Éléments | **Braise, Givre, Foudre, Poix, Chaux, Vif-argent** — réactions par paires (modèle *Genshin*) | Arsenal de siège crédible ; 15 réactions à partir de 6 pièces (§6.3) |
| Application des éléments | **Au sol autant que sur les ennemis** | Lisibilité, coût de rendu et regroupement d'un seul coup (§6.3) |
| Encodage visuel | État persistant discret, réaction spectaculaire | Sinon 1 500 lueurs permanentes et plus rien ne se lit (§6.6) |
| Palette | **Environnement sombre et désaturé** | Six couleurs saturées doivent rester distinguables (§6.6) |
| Assets | Tiny Swords en placeholder, **hors dépôt public** | Licence : redistribution interdite même modifiée (§12.2) |
| Synergie | Ne se charge **qu'entre joueurs différents** | Fait de la coopération une ressource (§6.5) |
| Friendly fire | **Non** | Pousse à la séparation, contraire à l'objectif (§8.1) |
| Contrainte de proximité | **Aucune punition de distance** | Une punition se lit comme un bug (§8.1) |
| Mort | Réanimation de proximité, puis fantôme actif | Personne ne regarde son écran (§8.2) |
| Structure de run | Boss toutes les 4 vagues, infini, pas de boss final | Le score est le palier atteint (§9) |
| Or | Non sécurisé jusqu'à extraction, perdu à l'effacement d'équipe | La tension du vote (§9.3) |
| Vote | Majorité, égalité = on continue | v1 ; l'extraction individuelle reste à tester (§9.3) |
| Identité | Jeton anonyme promouvable en compte e-mail | Entrée sans friction, identité réelle (§11) |
| Conventions | Biome, husky, commitlint, Vitest, Traefik | Alignement InkPoint / Gachapon (§12) |
| Code partagé | `shared/`, **sans contrainte de pureté** | Le client doit simuler la piétaille (§12) |

---

## 15. Questions ouvertes

Plus rien de bloquant depuis que le §1.1 arrête le nom et le thème. Ce qui suit se
tranche au moment d'aborder l'étape concernée.

### 15.1 Combien de classes, et quels verbes ?

La nature des classes est tranchée (§6.7 : un verbe, un trait, jamais un élément). Restent
le nombre exact au lancement — quatre est la proposition —, la sélection finale des verbes
parmi les six esquissés, et lesquels sont disponibles d'emblée plutôt que débloqués à
l'or. À trancher avant l'étape 3.

### 15.2 Taille de carte

« Immense » doit devenir un nombre. Il dépend directement du résultat de l'étape 1 : la
grille de flowfield coûte en `O(cellules)`, et une carte de 10 000 × 10 000 px à 64 px par
cellule fait ~24 000 cellules par champ, quatre fois.

> **Chiffré à l'étape 1** — voir
> [`../plans/2026-08-24-banc-resultats.md`](../plans/2026-08-24-banc-resultats.md).
>
> **Cellule retenue : 64 px. Recalcul à 10 Hz**, dont le surcoût par rapport à 5 Hz est
> inférieur à 0,05 ms.
>
> Le coût est linéaire : **23 ns par cellule visitée**. Le budget de 11 ms autorise donc
> ~117 000 cellules par champ à quatre champs, soit une carte de ~21 000 px de côté sur la
> machine de mesure, ~11 000 px sur une machine quatre fois plus lente.
>
> **Proposition : 10 000 × 10 000 px** — confortable sur les deux, et très en dessous du
> plafond de 32 767 qu'impose la quantification des positions en `int16` (§3.6). Cette
> contrainte-là est dure et vaut d'être notée : au-delà, c'est le format de trame qu'il
> faut rouvrir, pas un réglage.
>
> `MAP_SIZE` reste à 6 000 dans `shared/constants.ts` tant que l'étape 2 n'a pas de vagues
> à mettre dans une carte plus grande.

### 15.3 Classement mondial ?

S'il existe, l'assistance au jeu côté client cesse d'être un problème privé (§11) et il
faut décider quoi en faire. S'il n'existe pas, le sujet disparaît entièrement.

### 15.4 Plateformes

Le mobile change les entrées, la taille de viewport et le budget de rendu. À trancher tôt
si c'est envisagé — InkPoint a payé cher de l'avoir traité après coup.

---

## 16. Hors périmètre

- **PvP sous toutes ses formes.** Le jeu est coopératif ; l'ajouter plus tard
  invaliderait la moitié des décisions du §14, à commencer par l'assistance au jeu.
- **Cross-play console.** Rien ne l'interdit à terme, rien ne le prépare ici.
- **Chat vocal intégré.** Discord existe. La roue de ping (§8) est le substitut retenu.
- **Contenu généré par les joueurs**, éditeur de vagues, modding.
- **Économie payante** de quelque nature que ce soit.

---

## 17. Sources

- [The Tech Behind Swarm — Riot Games](https://www.riotgames.com/en/news/the-tech-behind-swarm)
  — ~550 sbires simultanés (pics vers 1 000) ; abandon de l'A\* par agent au profit d'un
  flowfield après un scaling quadratique ; sbires allégés répliquant « moins de données et
  plus sélectivement » ; buffs batchés par proxies réutilisables ; vagues data-driven en
  C++ ; particules à 34 ms/frame comme goulot client ; ~8× la bande passante à 4 joueurs
  vs 1 ; plafond de ~200 parties par machine imposé par l'overhead des threads réseau.
- [Swarm — League of Legends Wiki](https://wiki.leagueoflegends.com/en-us/Swarm)
  — expérience et or partagés par toute l'équipe ; gel du jeu et du chronomètre au
  level-up, 3 offres, 30 s de plafond, reprise progressive sur 1 s ; 5 armes (1 signature
  + 4) et 3 passifs extensibles à 6 ; évolution d'arme au niveau max avec le passif
  associé ; réanimation en 10 s par un allié, respawn 15 s +9 s par mort plafonné à 60 s ;
  ~15 min de temps de jeu avant boss, 20-25 min réelles.
- [Developing The Spell Brigade — 80.lv](https://80.lv/articles/developing-the-spell-brigade-online-co-op-action-game-about-wizards)
  — co-op 4 joueurs pensé dès le premier prototype ; prédiction client sur le déplacement
  des ennemis ; sorts possédés par le client, dégâts et impacts arbitrés serveur ; ciblage
  déterministe ; friendly fire comme choix d'identité.
- [Tiny Swords — Pixel Frog (itch.io)](https://pixelfrog-assets.itch.io/tiny-swords)
  — grille 64×64, animations 10 fps, sources `.aseprite`, cinq variantes de couleur par
  unité ; usage commercial autorisé, crédit facultatif, **redistribution interdite même
  après modification** ; *Enemy Pack* payant à ~10 $ (18 personnages).
- [Co-op bullet heaven games](https://bulletheavengames.com/genre/co-op/) — panorama du
  genre en coopératif en ligne.
- [20+ Great Co-Op Roguelikes — Rogueliker](https://rogueliker.com/coop-roguelikes/) —
  références de mécaniques coopératives hors bullet heaven.
- InkPoint, `README.md` et `docs/superpowers/specs/2026-08-02-leaderboard-architecture-design.md`
  — conventions de dépôt, stack, et le coût réel du déterminisme inter-moteurs.
