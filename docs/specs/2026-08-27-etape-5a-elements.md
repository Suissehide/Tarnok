# Étape 5a — les éléments : réserve de PV, zones au sol, première réaction, Synergie

> **Découpage assumé.** Le §13 de la spec d'orientation décrit une étape 5 unique : six éléments,
> quinze réactions, zones au sol, compteur de Synergie et encodage visuel du §6.6. C'est plus gros
> que les étapes 2, 3 et 4 réunies, et cinq sous-systèmes indépendants.
>
> Cette spec couvre **5a : la tranche verticale**. Deux éléments, une réaction, les zones, la
> Synergie. Le livrable du §13 est atteint en entier. Les quatre éléments et quatorze réactions
> restants deviennent alors **du contenu piloté par la donnée**, pas de l'architecture — c'est ce
> que le §6.3 promet : *« beaucoup de contenu à partir de peu de pièces »*.

**Orientation :** [`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md) — §6.3 à §6.6
**Étape précédente :** [`2026-08-26-etape-4-draft.md`](2026-08-26-etape-4-draft.md)

## 1. Périmètre

**Dans l'étape :**
- **la piétaille gagne une réserve de points de vie** — `Weapon.damage` cesse d'être inerte ;
- deux éléments : **Braise** et **Givre** ;
- les **zones au sol** : un nouveau type d'entité, avec durée de vie et recouvrement ;
- une réaction : **Choc thermique** (Braise + Givre) ;
- le **compteur de Synergie** : une réaction déclenchée par deux joueurs différents charge la barre,
  la même en solo ne charge rien ;
- l'encodage visuel minimal du §6.6 : quad teinté pour la zone, teinte de sprite pour l'ennemi
  marqué, flash pour la réaction.

**Hors de l'étape :**
- les quatre autres éléments et les quatorze autres réactions — contenu, étape 5b ;
- l'ultime d'équipe que la barre pleine déclenche (§6.5) — l'étape 5a **charge** la barre et
  l'affiche, elle ne dépense rien ;
- les élites et les boss, donc **toute barre de PV visible** : elle n'existe que pour les boss
  (étape 6) ;
- les classes et leurs verbes (§6.7).

## 2. Ce que cette étape ne met pas en danger

**Le contrat de réplication de l'étape 2 tient, et il ne doit rien coûter de plus par entité.**

Mille ennemis convergent identiquement à partir d'un message de 19 octets, et l'étape 3 a montré
que ça survit aux morts en retard, à la séparation et à trois changements du modèle de déplacement
— à 0,000 px de dérive. L'étape 4 n'y a pas touché.

L'état élémentaire est **la première donnée par entité que le projet rencontre**. La règle est donc
posée avant d'écrire une ligne :

| Donnée | Où elle vit | Sur le fil |
| --- | --- | --- |
| PV d'un ennemi | **serveur seul** | rien — `DEATHS` suffit, déjà en place depuis l'étape 3 |
| Élément porté par un ennemi | serveur pour l'arbitrage ; **approximé** côté client pour la teinte | rien |
| Zone au sol | annoncée à la création | ~12 octets, quelques dizaines vivantes |
| Réaction | annoncée | ~10 octets, rare |

**Le client n'a jamais besoin de connaître les PV.** Il apprend qui meurt par `DEATHS`, exactement
comme aujourd'hui. Une teinte de sprite est **cosmétique** : si le client marque un ennemi que le
serveur n'avait pas marqué, personne ne meurt de travers. La **réaction**, elle, est arbitrée
serveur et annoncée — c'est elle qui a des conséquences.

**Le trafic reste sans rapport avec le nombre d'entités.** Le test d'indépendance réseau de l'étape
2 doit rester vert, et les trois chiffres de réplication à 0,000 px avec lui.

## 3. La réserve de PV

### 3.1 Pourquoi elle arrive maintenant

À l'étape 3, un projectile qui touche est **toujours** létal : la piétaille n'a aucune réserve, et
`Weapon.damage` est transporté sans moduler quoi que ce soit. Deux conséquences, l'une connue et
l'autre découverte à l'étape 4 :

- **deux passifs sur cinq ne font rien.** « Puissance » et « acier » calculent un bonus de dégâts
  qui ne change aucune issue. C'est le point ouvert le plus gênant de l'étape 4 ;
- **un ennemi ne peut pas porter un élément**, puisqu'il meurt au premier impact. Le modèle du
  §6.3 est mécaniquement impossible sans PV.

### 3.2 Où elle vit

`Archetype` gagne un champ `hp`, à côté de `speed`. Table pilotée par la donnée, l'index est
l'identifiant — même motif que partout ailleurs dans `shared/`.

**Les deux côtés dérivent les mêmes PV de départ sans un octet de plus** : l'archétype d'une vague
voyage déjà dans l'ordre de vague de 19 octets. Seul le serveur soustrait les dégâts.

### 3.3 La calibration est une porte, pas un réglage

**Donner des PV réduit mécaniquement le rythme de mise à mort, et l'étape 3 a déjà failli mourir
de là.** Son rapport le dit : le générateur de vagues était resté calibré pour un test de charge du
rendu — ~37 apparitions/s contre 2 morts/s — et la montée de niveau était inatteignable avant que
le joueur ne meure encerclé.

La dague inflige 5 dégâts toutes les 7 ticks. **Un archétype à 5 PV meurt donc exactement comme
aujourd'hui** : le rythme de l'étape 3 est préservé à l'identique, et c'est le point de départ.

Mais un ennemi qui meurt en un coup ne porte jamais d'élément assez longtemps pour réagir. **La
réserve doit donc varier par archétype** — et c'est la première fois que le choix d'un archétype
veut dire autre chose qu'un sprite et une vitesse.

| Rôle | PV visés | Ce qu'il faut qu'il se passe |
| --- | --- | --- |
| Piétaille légère | 5 | meurt en un coup de dague — le rythme de l'étape 3, inchangé |
| Piétaille lourde | 15 à 25 | survit deux à cinq coups : **assez pour porter un élément** |

**Le réglage se juge en jeu, pas au banc.** Décision de l'auteur :

> *« Pas besoin de mesurer le rythme de mise à mort, je testerai et ferai des retours. »*

`back/bench/kills.bench.ts` existe et a servi une fois — il a montré que `hp = 5` ne coûte rien
(+0,9 %) et que 20 % de piétaille lourde coûte −12,8 %. Il reste **disponible à la demande**
(`npm run bench:kills -w back`) pour vérifier qu'un changement ultérieur ne ruine pas le rythme en
silence, mais **il ne fait plus partie de la chaîne `npm run bench` et n'est plus une porte.**

Les leviers de réglage, dans l'ordre où il faut les toucher :

| Levier | Départ | Ce qu'il fait |
| --- | --- | --- |
| `HEAVY_WAVE_SHARE` | 0,20 | part de piétaille lourde dans une vague |
| `HEAVY_FIRST_WAVE` | 6 | avant cette vague, aucun lourd |
| `WAVE1_MIN/MAX_COUNT` | 10 / 18 | taille des premières vagues |
| `RAMP_WAVES` | 30 | sur combien de vagues la montée s'étale |
| `Archetype.hp` | 5 / 20 | **en dernier** — c'est ce qui déplace tout le reste |

### 3.4 Ce qui n'est PAS visible

**Aucune barre de PV.** Elle n'existe que pour les boss, qui appartiennent à l'étape 6. La piétaille
et la piétaille lourde n'affichent rien : le joueur lit leur état à la teinte élémentaire et à leur
mort, pas à une jauge.

## 4. Les éléments

### 4.1 Deux, et pourquoi ces deux-là

**Braise** et **Givre**, parce que leur réaction — le **Choc thermique** — est celle dont l'effet est
le plus lisible du §6.4 : *« dégâts bruts massifs sur une cible, brise l'armure »*. Un effet qui se
voit sans explication est ce qu'il faut pour juger le système à l'œil.

| Élément | Effet seul, à cette étape |
| --- | --- |
| **Braise** | dégâts sur la durée |
| **Givre** | ralentit |

Le gel sur accumulation du §6.3 est hors périmètre : il demande un compteur d'application par
entité, donc une seconde donnée par entité, et cette étape n'en introduit qu'une.

### 4.2 Une arme porte un élément

`Weapon` gagne `element`, qui vaut `NEUTRE` par défaut. Le catalogue actuel compte neuf armes ; deux
passent en Braise, deux en Givre, les cinq autres restent neutres. La proportion visée du §6.3
— six à sept armes par élément sur quarante — est une cible de contenu, pas de cette étape.

**Une arme neutre reste utile.** Le §6.3 en fait *« un filet pour les débuts de run et un socle pour
les joueurs qui ne veulent pas jouer le système »*. L'arme de base l'est, et le reste.

### 4.3 Un ennemi porte au plus un élément

**Une seule donnée par entité, et c'est délibéré.** Un ennemi marqué Braise que touche un projectile
Givre ne devient pas « Braise + Givre » : **il réagit immédiatement**, et la marque se consomme.

C'est le modèle du §6.3 — *« l'application d'un second élément différent sur un ennemi déjà affecté
déclenche une réaction »* — et il évite d'avoir à stocker un couple.

La marque porte trois choses : **quel élément**, **quel joueur l'a appliquée**, et **jusqu'à quel
tick elle dure**. Le joueur est ce qui rend la Synergie du §6.5 possible.

## 5. Les zones au sol

### 5.1 Ce que c'est

Un disque teinté, posé là où un projectile élémentaire finit sa course — qu'il ait touché ou non.
Il vit un nombre de ticks fixe, puis disparaît.

⚠️ **« Un projectile = une zone » ne tient pas, et c'est mesuré.** La cadence d'une arme
élémentaire deviendrait le principal levier de coût du jeu, et **l'empilement de l'étape 4 la fait
exploser** — chaque exemplaire ajoute un projectile à la salve :

| Armes élémentaires retenues | Zones vivantes à quatre joueurs |
| --- | --- |
| 1 exemplaire chacune | **90** |
| 4 exemplaires | **209** |
| 8 exemplaires | **368** |

Contre *« quelques dizaines »* budgétées au §6.6 de l'orientation, et un recouvrement en O(zones²).
Le lance-flammes seul (18 projectiles/s) en porterait **216 à lui tout seul**.

**Choisir des armes à cadence lente n'est donc pas une parade** : c'est un réglage qui tient
jusqu'au premier draft. La borne doit vivre dans la règle de pose.

### 5.1 bis La règle de pose, bornée par construction

**Une zone ne s'ajoute pas si son centre tombe DANS une zone du même élément : elle la rafraîchit.**
Le `bornTick` de l'existante repart, la nouvelle n'est pas créée.

⚠️ **« Dans une zone », pas « recouvre une zone ».** Une première version de ce paragraphe disait
« recouvre », c'est-à-dire disques sécants, soit une distance de centres inférieure à **deux**
rayons. Conséquence : deux zones du même élément se retrouveraient toujours à plus d'un diamètre
l'une de l'autre et **ne se recouvriraient jamais** — une traînée de tir aurait des trous visibles
entre les disques. Trouvé à l'exécution.

Ce sont donc **deux prédicats distincts**, et il ne faut pas les confondre :

| Question | Prédicat |
| --- | --- |
| Faut-il fusionner à la pose ? | le **centre** tombe dans une zone existante — distance < `ZONE_RADIUS` |
| Deux zones réagissent-elles ? | les **disques** sont sécants — distance < `2 × ZONE_RADIUS` |

La borne tient dans les deux cas — les centres restent à au moins un rayon l'un de l'autre, donc le
compte reste fonction de la surface — mais seul le premier laisse une traînée continue.

Le nombre de zones devient alors fonction de la **surface couverte**, pas de la cadence ni du
nombre d'exemplaires. Un joueur qui arrose le même endroit entretient une zone ; un joueur qui
balaie la carte en pose plusieurs, et c'est le comportement qu'on veut voir.

**Et un plafond dur en second rideau**, avec un compteur, exactement comme `PROJECTILE_CAPACITY` et
`truncatedProjectiles` de l'étape 4 : une zone qui ne se pose pas faute de place est un effet que le
joueur a payé et qui ne se voit pas. **Ça ne doit jamais disparaître sans trace.**

**Le précédent existe déjà** : `OrbField` fait exactement ça pour les orbes d'expérience, avec une
expiration **dérivée** des deux côtés à partir du `bornTick`, sans message de disparition. Les zones
suivent ce modèle.

### 5.2 Ce qu'elles font

- un ennemi **dans** une zone reçoit sa marque élémentaire, rafraîchie tant qu'il y reste ;
- **deux zones d'éléments différents qui se recouvrent réagissent**, à la frontière commune ;
- une zone qui réagit se consomme.

C'est la seconde voie du §6.3 : *« une réaction se déclenche de deux façons : un ennemi déjà affecté
reçoit un second élément, **ou deux zones au sol se recouvrent** »*.

### 5.3 Pourquoi elles sont annoncées et pas dérivées

Le client ne peut pas savoir où finit un projectile serveur : les siens sont **cosmétiques** depuis
l'étape 3, tirés depuis une position prédite puis réconciliée. Une zone dérivée localement
dériverait de quelques pixels, et deux zones qui se recouvrent d'un pixel décident d'une réaction.

**Elles sont donc annoncées à la création, et leur mort est dérivée** — même partage que les orbes.
Quelques dizaines vivantes, ~12 octets chacune : c'est le budget que le §6.6 avait déjà posé
(*« grand quad teinté, additif, quelques dizaines de quads »*).

## 6. La réaction

### 6.1 Choc thermique

Braise + Givre. Dégâts bruts massifs sur la cible, et sur les ennemis dans un rayon court.

**Elle est arbitrée par le serveur et annoncée**, parce qu'elle tue. Le message porte où, quel
couple d'éléments, et **les deux joueurs à l'origine** — c'est ce que la Synergie consomme.

### 6.2 Ce qui la déclenche, exactement

| Situation | Réaction |
| --- | --- |
| Ennemi marqué Braise, touché par un projectile Givre | oui |
| Ennemi marqué Braise, entrant dans une zone Givre | oui |
| Deux zones d'éléments différents qui se recouvrent | oui, une fois, à la création de la seconde |
| Ennemi marqué Braise, touché par un projectile Braise | non — la marque se rafraîchit |

**Une réaction par ennemi et par tick, au plus.** Sans cette borne, une zone Givre posée sur vingt
ennemis marqués Braise déclenche vingt réactions au même tick, chacune infligeant des dégâts de
zone à ses voisins : la cascade est un risque de coût autant que de lisibilité.

## 7. Le compteur de Synergie

**Le §6.5 l'appelle « le cœur du projet ».**

> *Quand une réaction est déclenchée par deux joueurs différents — l'un a appliqué le premier
> élément, l'autre le second — l'équipe gagne une charge. Déclenchée en solo, la même réaction ne
> rapporte rien.*

C'est pour ça que la marque élémentaire retient **qui l'a appliquée**. À la réaction, le serveur
compare le joueur de la marque et le joueur du projectile ou de la zone qui la déclenche :

- **différents** → une charge, et la barre monte pour toute l'équipe ;
- **le même** → la réaction a lieu, elle ne rapporte rien.

La barre est une donnée d'équipe, comme l'expérience de l'étape 3 : **un seul nombre dans le
snapshot**, pas un par joueur.

**En solo la barre ne monte jamais**, par construction, et c'est voulu — le §6.5 en fait un outil de
regroupement qui fonctionne *par le gain, jamais par la punition*.

## 8. Le protocole

Deux messages nouveaux, tous deux datés par tick.

| Message | Sens | Contenu |
| --- | --- | --- |
| `ZONE` | S → C | élément, x, y, rayon, tick de naissance, joueur |
| `REACTION` | S → C | couple d'éléments, x, y, tick, **charge de Synergie ou non** |

La charge de Synergie voyage **dans** `REACTION` plutôt que dans un message à part : les deux
arrivent toujours ensemble, et un second message ne porterait rien de plus.

Le total de la barre voyage dans le `SNAPSHOT`, à côté de l'expérience d'équipe — **un `u16`,
partagé, pas un par joueur.**

⚠️ **La mort d'une zone n'est jamais annoncée.** Elle se dérive du `bornTick` et d'une constante,
exactement comme l'expiration des orbes (§6.1 de l'étape 3). Un message de disparition doublerait le
trafic des zones pour une information que les deux côtés calculent déjà.

## 9. L'encodage visuel

La hiérarchie du §6.6 s'applique telle quelle, réduite à ce que cette étape produit :

| Ce qu'il faut montrer | Encodage | Coût |
| --- | --- | --- |
| Zone au sol | grand quad teinté, additif | quelques dizaines de quads |
| Un élément sur un ennemi | **teinte du sprite** — gratuite dans le batch Pixi | 0 |
| La réaction | **flash court, large, généreux** | c'est là que passe le budget VFX |
| La barre de Synergie | une jauge dans le HUD, visible de tous | 1 quad |

**La règle qui évite la bouillie : l'état persistant est discret, la réaction est spectaculaire.**
Si les ennemis marqués brillent en permanence, plus rien ne se lit.

L'anneau bicolore du §6.6 — deux éléments avant réaction — **n'existe pas ici** : un ennemi ne porte
jamais deux éléments (§4.3), il réagit.

## 10. Vérification

**Le livrable du §13, en entier :**

> *Une réaction inter-joueurs charge la barre, une réaction solo non ; deux zones qui se recouvrent
> réagissent.*

Un test d'intégration à quatre clients réels, comme celui de l'étape 4 : deux joueurs marquent et
déclenchent, la barre monte ; le même joueur fait les deux, la barre ne bouge pas.

**Ce qui doit rester vrai :**
- les **trois chiffres de réplication à 0,000 px** ;
- l'**indépendance du trafic** au nombre d'entités, mesurée au banc réseau ;
- le budget de pas p95 < 11,11 ms, avec le nouveau coût du recouvrement de zones.

**Ce qui relève du jugement, et que rien n'automatise :**
- une piétaille avec des PV **se sent-elle** encore comme de la chair à canon, ou comme une éponge ?
- la réaction se lit-elle **sans explication** ?
- la teinte élémentaire se distingue-t-elle à 1 500 entités sur des sprites minuscules — c'est *« le
  problème visuel le plus difficile du projet »* selon le §6.6, et seul l'œil en juge.

## 11. Écarts assumés

**§6.3 — le gel sur accumulation du Givre est reporté.** Il demande un compteur d'application par
entité, donc une seconde donnée par entité. Cette étape n'en introduit qu'une, délibérément.

**§6.6 — l'anneau bicolore n'existe pas.** Il encode « deux éléments, avant réaction », un état que
le modèle du §4.3 ne produit jamais.

**§13 — l'étape 5 est coupée en deux.** 5a livre le mécanisme, 5b le contenu.

## 12. Questions laissées ouvertes

- **Combien de temps dure une marque élémentaire ?** Trop court, aucune réaction n'a lieu ; trop
  long, tout réagit tout le temps. **Tranché : à tester en jeu.** `MARK_DURATION_TICKS` part de 60
  (2 s) ; `tsx watch` relance le back tout seul, donc le régler revient à éditer un nombre et
  recharger la page. C'est la tâche 11 du plan.
- **Un ennemi qui meurt d'une réaction laisse-t-il un orbe ?** Oui par défaut — sinon le système
  élémentaire punirait l'expérience de l'équipe. À vérifier au playtest.
- **La proportion de piétaille lourde dans les vagues** est le vrai levier de difficulté de cette
  étape, et elle n'a pas de valeur de départ défendable avant la mesure du §3.3.
