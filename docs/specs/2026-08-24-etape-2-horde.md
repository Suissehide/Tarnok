# Tarnok — étape 2 : la horde

Spec de l'étape 2 du §13 de
[`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md).
Les références en `§` renvoient à ce document d'orientation.

**Livrable vérifiable seul : 1 000 ennemis convergent identiquement sur 4 clients, sans
qu'aucune position de monstre ne transite sur le fil.**

Cette étape met en œuvre la décision technique structurante du projet — le §3.3, « on ne
réplique pas la horde, on réplique son générateur ». C'est la seule étape dont l'échec
invaliderait l'architecture réseau entière.

---

## 1. Périmètre

### Dans l'étape

- Un module de horde **partagé**, exécuté à l'identique par le serveur et par chaque client.
- Des **ordres de vague** diffusés par le serveur : une poignée d'octets par vague.
- Convergence par **flowfield**, déjà implémenté et testé dans `shared/flowfield.ts`.
- Rendu **batché** en `ParticleContainer`, animé, un seul atlas.
- Quatre archétypes de piétaille câblés, sur les vingt que la table du §8 recense.

### Hors de l'étape, et pourquoi

| Exclu | Renvoyé à | Raison |
| --- | --- | --- |
| Morts, dégâts, collisions | étape 3 | Le §13 y met le combat. Sans combat, rien ne meurt. |
| Élites et mini-boss | étape 6 | **Régime de réplication différent** — vraies entités répliquées, pas un générateur. Les mélanger ici rendrait l'étape non vérifiable seule. |
| Séparation entre entités | étape 3 | Le banc de l'étape 1 ne l'a pas mesurée et la désigne comme prochain goulot probable. |
| Les 16 autres archétypes | au fil de l'eau | C'est du contenu, pas de l'architecture. |

Le **canal de morts** du §3.3 est *conçu* dans le protocole — l'identité arithmétique du §3
existe pour lui — mais n'est pas câblé.

---

## 2. Le contrat de réplication

### 2.1 Ce qui transite

| Objet | Sur le fil | Volume |
| --- | --- | --- |
| Les 4 joueurs | positions, 30 Hz | 26 o par snapshot |
| **La horde** | **rien** | **0 octet, quel que soit N** |
| Ordre de vague | 1 message | 19 octets (18 de charge utile + 1 d'octet de type), une fois par vague |
| Graine de carte | 1 message | 4 octets, au `WELCOME` |

Répliquer naïvement 1 000 ennemis à 30 Hz coûterait **~150 ko/s par joueur**. Le banc de
l'étape 1 mesure 0,47 ko/s avec la réplication actuelle ; l'étape 2 n'y ajoute rien de
récurrent.

### 2.2 Ce qui doit être identique, et ce qui a le droit de diverger

C'est la distinction qui porte toute l'étape.

| | Garantie | Mécanisme |
| --- | --- | --- |
| Ensemble des identités vivantes | **exacte** | arithmétique entière, aucun flottant |
| Archétype d'une entité | **exact** | idem |
| Tick d'apparition | **exact** | idem |
| **Position** | **approximative**, bornée | flottants, ordre d'opérations |

Le §12.1 l'autorise explicitement : `shared/` ici vise la **ressemblance**, pas la
reproduction au bit près d'InkPoint. Le §3.4 ferme le seul endroit où ça compte — le
contact — en donnant le dernier mot au serveur, avec une hitbox généreuse penchant en
faveur du joueur.

### 2.3 L'identité est arithmétique

```
entityId = waveId × MAX_PAR_VAGUE + index
```

Aucune négociation, aucun octet, aucun aller-retour. Deux clients qui reçoivent le même
ordre de vague **ne peuvent pas** fabriquer des identifiants différents.

C'est ce qui rendra sensé, à l'étape 3, un message « l'entité 4211 est morte » : il n'y a
pas de table de correspondance à synchroniser, donc pas de table à désynchroniser.

`MAX_PAR_VAGUE = 4096` et `waveId` sur 16 bits donnent 268 millions d'identités par partie —
sans recyclage, ce qui évite la classe de bugs « l'entité 12 n'est pas la même entité 12 ».

---

## 3. L'ordre de vague

Le seul message que le serveur décide et diffuse pour la horde. **19 octets sur le fil : 1
octet de type + 18 octets de charge utile.**

| Champ | Type | Rôle |
| --- | --- | --- |
| *(type de message)* | `u8` | `MSG.WAVE_ORDER`, comme tout message du protocole (§7) |
| `waveId` | `u16` | base des identités, et ordre de la vague |
| `spawnTick` | `u32` | tick d'apparition, en temps serveur |
| `seed` | `u32` | graine du tirage des positions |
| `archetype` | `u8` | index dans la table du §8 |
| `formation` | `u8` | voir §3.1 |
| `anchorX` | `i16` | centre de la formation, en pixels monde |
| `anchorY` | `i16` | idem |
| `count` | `u16` | nombre d'entités |

Les vagues sont **pilotées par la donnée, pas par du script** — troisième leçon volée à
Riot (§9.1). Une définition de vague est une valeur typée dans `shared/`, exécutée par un
système unique.

### 3.1 Formations

`formation` sélectionne une fonction pure `(seed, count, anchor) → positions`.

| Valeur | Nom | Forme |
| --- | --- | --- |
| 0 | `SCATTER` | dispersion uniforme dans un disque |
| 1 | `RING` | anneau autour de l'ancre |
| 2 | `COLUMN` | colonne serrée, orientée par la graine |
| 3 | `CLUSTER` | quelques grappes denses |

Le §4.1 rappelle pourquoi ça compte : la sensation de masse se fabrique par des
**formations denses de chair à canon**, pas par un compteur.

### 3.2 Le générateur pseudo-aléatoire remonte dans `shared/`

Le `xorshift32` écrit pour le banc de l'étape 1 (`back/bench/harness.ts`) devient
`shared/random.ts`. C'est lui qui transforme `seed` en positions, identiquement des deux
côtés.

**Contrainte :** il ne doit être utilisé qu'à **l'apparition**, jamais par tick. Un tirage
par tick ferait dépendre l'état du nombre de pas exécutés, et la moindre différence de
cadence divergerait sans retour.

---

## 4. Le module de horde partagé

`shared/horde.ts`. État en **tableaux typés**, jamais un objet par ennemi (§4.4) :

```
x, y            Float32Array
archetype       Uint8Array
waveId          Uint16Array   // vague d'origine, base de l'identité arithmétique (§2.3)
indexInWave     Uint16Array   // rang dans la vague, avec waveId : pour retrouver l'identité
animPhase       Uint8Array    // décalage d'animation, dérivé de l'index (§9.3)
targetField     Uint8Array    // index du champ suivi : le joueur le plus proche
count           number        // les entités vivantes occupent [0, count)
```

Interface :

- `spawn(order: WaveOrder)` — instancie `count` entités selon la formation.
- `step(dt, fields)` — un pas fixe : chaque entité lit le gradient de sa cellule.
- `retarget(playerX, playerY)` — réaffecte `targetField` au joueur le plus proche.

Le rendu (`front/src/render/horde-renderer.ts`) lit directement les tableaux exposés par
`Horde` — pas de méthode `positionsFor` intermédiaire : à cette échelle, une copie
supplémentaire coûterait plus qu'elle ne rapporte.

**Le serveur et le client exécutent le même code.** Le serveur reste néanmoins autoritaire :
c'est son état qui fera foi à l'étape 3.

### 4.1 Le ciblage

Chaque entité suit le champ du **joueur le plus proche**, recalculé en même temps que les
champs (10 Hz) et non à chaque tick — changer de cible chaque tick fait vibrer les
trajectoires.

---

## 5. Alignement des entrées du flowfield

**C'est le point le plus délicat de l'étape, et il n'est pas évident.**

Le flowfield se calcule à partir des positions des 4 joueurs. Le serveur les connaît à
l'instant présent ; le client ne connaît celles des autres qu'avec du retard. Deux entrées
différentes donnent deux champs différents — et une erreur de *direction* ne se rattrape
pas : elle s'accumule à chaque pas.

**Décision : les deux côtés calculent le champ à partir des positions du tick `T − K`, avec
`K = 3` ticks (100 ms).** Le serveur s'impose le retard qu'il inflige au client, en gardant
un court historique des positions de joueurs. Les entrées deviennent identiques ; la
divergence retombe au bruit des flottants.

Ce que ça coûte : les ennemis réagissent à un changement de direction 100 ms plus tard. Le
champ n'étant déjà recalculé qu'à 10 Hz — granularité de 100 ms — on ne rajoute rien de
perceptible. **On remplace une divergence non bornée par un retard qu'on avait déjà.**

`K` doit couvrir la latence : au-delà de 100 ms de RTT, un client n'a pas encore reçu le
snapshot du tick `T − K` et doit s'accrocher au dernier connu. C'est une dégradation
gracieuse, pas une panne, mais elle est à mesurer (§10).

### 5.1 La carte d'obstacles

Le champ ne concorde que si les deux côtés murent les mêmes cellules. Une `mapSeed` envoyée
au `WELCOME` suffit : **le client régénère la carte, il ne la reçoit pas.** La fonction de
génération vit dans `shared/`.

---

## 6. Lignes de temps

| Objet | Ligne de temps | Pourquoi |
| --- | --- | --- |
| Joueur local | **maintenant**, prédit | la commande doit répondre à l'image suivante |
| **Horde** | **maintenant** | elle partage la ligne de temps de ce qu'elle poursuit |
| Autres joueurs | maintenant − 60 ms, interpolés | on ne peut pas connaître leur présent |
| Projectiles alliés (étape 3) | **maintenant** | générés depuis l'événement de tir, pas répliqués |

Les deux choses qui se touchent — mon personnage et les ennemis — sont cohérentes entre
elles, donc esquiver répond juste. Le corps d'un allié est décalé d'au plus **26 px** à
260 px/s, soit 0,4 sprite : cosmétique. L'inverse — une horde en retard sur mon personnage —
casserait la seule latence que les joueurs perçoivent vraiment.

### 6.1 Deux constantes changent

| Constante | Avant | Après | Raison |
| --- | --- | --- | --- |
| `SNAPSHOT_HZ` | 20 | **30** | un tampon de 60 ms ne contient que 1,2 intervalle à 20 Hz |
| `INTERP_DELAY_MS` | 100 | **60** | ramène le décalage du corps des alliés de 26 à 15 px |

Écart assumé vis-à-vis du §3.5, qui proposait 15-20 Hz de diffusion. Il est **payé par la
mesure** : le banc de l'étape 1 donne 0,47 ko/s par joueur contre 5-15 estimés au §3.3.
Passer à 30 Hz coûte ~0,7 ko/s — toujours dix fois sous l'estimation. C'est exactement à ça
que sert un banc : dépenser une marge mesurée pour acheter de la réactivité.

### 6.2 L'apparition tardive, et pourquoi le client doit rattraper

> **Mesuré pendant l'implémentation, le 24 août 2026.** Ce paragraphe corrige une
> hypothèse du §3.3 de l'orientation, fausse d'un facteur 40.

Un client **ne peut pas** faire apparaître une vague au même tick que le serveur : l'ordre
voyage sur le réseau. Il l'appliquera un ou deux ticks plus tard (33 à 66 ms), et ses
entités auront donc été avancées d'un ou deux pas de moins.

Le §3.3 de l'orientation suppose que c'est bénin — « une divergence de trois pixels sur un
monstre qui vit deux secondes est invisible ». **C'est faux.** Mesure sur cinq simulations,
1 000 entités, apparition retardée de 1 à 2 ticks :

| Âge de l'entité | Sans rattrapage | Avec rattrapage |
| --- | --- | --- |
| 0,5 s | 25,7 px | **20,3 px** |
| 1 s | 52,8 px | **20,3 px** |
| 2 s | **122,7 px** | **20,3 px** |
| 4 s | 279,1 px | **20,3 px** |
| 10 s | 694,7 px | **20,3 px** |

Sans rattrapage, la dérive croît **linéairement, à ~70 px/s**, sans borne.

**La cause n'est pas celle qu'on croit.** Ce n'est pas la bascule de cible de `retarget` —
vérifié par expérience : en forçant une cible unique, donc aucune bascule possible, la
dérive reste à 714 px. C'est **le flowfield lui-même**. Il donne huit directions discrètes
par cellule de 64 px : deux entités décalées d'un seul pas franchissent les frontières de
cellules à des instants différents, prennent des directions différentes, et l'écart
s'installe. Un champ de directions discret est intrinsèquement sensible aux conditions
initiales.

**Décision : le client rattrape les pas manqués à l'apparition.** Il connaît `spawnTick`
(il est dans l'ordre de vague) et son propre tick ; en appliquant l'ordre, il avance les
**nouvelles** entités du nombre de pas manqués, avec son champ courant.

La dérive devient alors **constante à 20,3 px**, quel que soit l'âge — elle ne croît plus.
Les 20 px résiduels sont l'erreur de fraîcheur du champ : le client rattrape avec le champ
d'aujourd'hui, là où le serveur a utilisé ceux d'il y a un ou deux ticks. Un tiers de
sprite, ce qui rentre dans la « ressemblance » du §12.1 — cette fois pour de vrai, avec un
chiffre.

**Ce que ça change pour la suite.** La leçon dépasse l'apparition : *toute* différence
d'état initial entre deux simulations s'amplifie linéairement au lieu de rester bornée. Le
mécanisme du §3.3 ne tolère donc pas les approximations « petites » — il exige que les
entrées soient identiques. C'est à garder en tête à l'étape 3, quand les morts viendront
retirer des entités et qu'un décalage d'un tick sur une mort produira le même effet.

---

## 7. Protocole

Trois changements, tous additifs.

| Message | Changement |
| --- | --- |
| `WELCOME` | `+ mapSeed u32` |
| `WAVE_ORDER` | **nouveau**, 19 octets sur le fil, dont 18 de charge utile (§3) |
| `SNAPSHOT` | inchangé — les 4 joueurs, à 30 Hz |

Le décodeur lève déjà sur un buffer tronqué et sur un type inconnu ; les tests existants de
`shared/protocol.test.ts` s'étendent aux nouveaux messages.

**Fiabilité.** Un `WAVE_ORDER` perdu fait manquer une vague entière à un client. WebSocket
étant au-dessus de TCP, la livraison est garantie et ordonnée : aucun mécanisme d'accusé
n'est nécessaire. Cette dépendance est notée ici parce qu'elle disparaîtrait si le transport
changeait un jour pour WebTransport ou UDP.

---

## 8. Le bestiaire

Vingt créatures, deux régimes. **La taille des sprites tombe pile sur la distinction du
§3.3**, ce qui n'est pas un hasard : les grosses ont `Windup` / `Attack` / `Recovery` en
planches distinctes, ce qui est un vocabulaire de boss ; la piétaille n'a besoin que de
`Walk`.

### 8.1 Piétaille — répliquée par le générateur, rendue en batch

Cellule 192 px. `Run` ou `Walk` selon la créature.

| # | Créature | Images | Étape 2 ? |
| --- | --- | --- | --- |
| 0 | Skull | 6 | **oui** |
| 1 | Gnoll | 8 | **oui** |
| 2 | Spider | 5 | **oui** |
| 3 | Torch Goblin | 6 | **oui** |
| 4 | Lizard | 6 | |
| 5 | Snake | 8 | |
| 6 | Gnome | 6 | |
| 7 | Slingshot Gnome | 6 | |
| 8 | Thief | 6 | |
| 9 | Giant Bat | 4 | |
| 10 | Bomb Fish | 6 | |
| 11 | Hex Shaman | 4 | |
| 12 | Paddle Shark | 6 | |
| 13 | Harpoon Shark | 6 | |

Les quatre de l'étape 2 sont choisis pour leurs **silhouettes franchement distinctes** —
crâne flottant, hyène debout, araignée basse, gobelin à torche — parce que le but est de
vérifier qu'on distingue les archétypes dans une mêlée, pas de remplir une table.

### 8.2 Élites et mini-boss — répliquées comme entités, rendues en `Sprite`

Hors périmètre de l'étape 2. Recensées ici pour que les ajouter soit du contenu.

| Créature | Cellule | Note |
| --- | --- | --- |
| Spear Goblin | 256 | a une `Attack Strong` séparée |
| Bear | 256 | |
| Panda | 256 | |
| Turtle | 320 | `Guard_In` / `Guard_Out` : posture défensive |
| Minotaur | 320 | |
| **Troll** | **384** | `Windup` / `Attack` / `Recovery` / `Dead` en morceaux — le vocabulaire de boss le plus complet du pack |

Ces entités sont peu nombreuses (1 à 20, §3.3), donc leur réplication position par position
est abordable, et elles gardent leurs textures individuelles sans contrainte d'atlas.

---

## 9. Rendu

### 9.1 Un `ParticleContainer`, un atlas

Propriétés dynamiques : `position`, `uvs`, `color`.

- `uvs` est ce qui permet l'**animation** — la documentation de Pixi v8 est explicite :
  *« When true, texture coordinates are updated each frame. Required for texture
  animation. »*
- `color` donne gratuitement, dans le batch, la **teinte élémentaire** que le §6.6 exigera à
  l'étape 5. Rien à refaire alors.

**Contrainte dure : une seule texture de base.** Toutes les images de piétaille vivent dans
le même atlas, sinon le batch casse et l'intérêt disparaît.

### 9.2 L'atlas

Construit **hors ligne** par `tools/build_monster_atlas.py` (Python + Pillow, comme
`build_iso_atlas.py` déjà présent), déposé sur MinIO avec le reste. Il n'entre ni dans le
dépôt ni dans l'image Docker — licence Pixel Frog, voir `NOTICE-assets.md`.

Les planches sources sont des bandes horizontales dont la **cellule est carrée, de côté égal
à la hauteur** : `Gnoll_Walk.png` en 1536×192 fait 8 images de 192.

Surface des 14 piétailles : **3,06 Mpx**. Toutes les cellules faisant 192 de haut, un
rangement par étagères est quasi optimal : dix rangées de 192 dans 2048 de haut offrent
3,93 Mpx utiles. **L'atlas tient donc en 2048×2048**, très en dessous de la limite sûre de
4096 sur GPU de bureau.

Le script écrit à côté un `monsters.json` : pour chaque archétype, le rectangle de chaque
image et le nombre d'images.

### 9.3 Animation

Chaque entité a une `animPhase` **dérivée de son index dans la vague** à l'apparition — pas
tirée au hasard : `(index × 7 + waveId × 3) mod frames`. La phase décale le cycle : sans elle,
mille crânes marchent au pas, ce qui se voit immédiatement. Dérivée plutôt que tirée, elle
reste identique sur toutes les simulations sans le moindre octet supplémentaire sur le fil —
et une capture d'écran de debug reste comparable d'une simulation à l'autre. À 10 images par
seconde, comme le pack (§12.2).

**L'animation est purement cosmétique et n'entre pas dans le contrat de réplication.** Deux
clients peuvent afficher des images différentes du même ennemi sans conséquence.

### 9.4 Tri en profondeur

Un `ParticleContainer` dessine dans l'ordre du tableau : trier, c'est réordonner le tableau.
Le §4.5 tranche déjà — **rangement en compartiments par bandes horizontales**, pas un
`sort()` global. Bandes de 64 px ; à l'intérieur d'une bande, l'ordre est indifférent.

### 9.5 Zone d'intérêt

Le client simule **toute** la horde mais ne dessine que ce que sa caméra voit. Le §4.5
rappelle pourquoi la vue de dessus rend ce filtrage trivial : la fenêtre visible est un
rectangle aligné sur les axes du monde.

Simuler tout est assumé : le banc de l'étape 1 mesure **0,02 ms pour déplacer 4 000
entités**. Filtrer la simulation coûterait plus cher en complexité qu'il ne rapporte, et
introduirait une divergence supplémentaire — un client qui ne simule pas une entité doit
pouvoir la reprendre exactement quand elle entre dans sa zone.

---

## 10. Vérification

### 10.1 Le test qui porte le livrable

`shared/horde.replication.test.ts` — **headless, sans navigateur.**

L'étape 0 a montré qu'une vérification à l'œil dans des onglets est trompeuse : un onglet en
arrière-plan a son `requestAnimationFrame` suspendu et sa capture d'écran montre une image
périmée. Ce test ne dépend d'aucun rendu.

1. Instancier **quatre** simulations partagées, plus celle du serveur.
2. Leur donner les mêmes ordres de vague, avec **1 000 entités**.
3. Avancer **600 pas** en injectant des positions de joueurs qui bougent.
4. Assertions, à chaque tick :
   - l'**ensemble des identités** est strictement égal entre les cinq — égalité exacte ;
   - l'**écart de position** de chaque entité reste sous **2 px**.

Le seuil est une valeur de départ à confirmer par la mesure ; le test rapporte la dérive
maximale observée, pour que le chiffre soit lisible plutôt que caché.

### 10.2 Le test qui prouve l'absence de positions sur le fil

Un test d'intégration compte les octets reçus par un client pendant une vague de 1 000
entités et vérifie que le volume est **indépendant du nombre d'entités** : mêmes octets à
100 qu'à 1 000, à l'ordre de vague près.

C'est la formulation testable de « sans position sur le fil » — bien meilleure qu'une
inspection de code, parce qu'elle survit aux refactorisations.

### 10.3 Tests unitaires

- Formations : déterminisme (même graine → mêmes positions), et respect du nombre demandé.
- Identité : pas de collision entre vagues, pas de recyclage.
- Protocole : aller-retour des nouveaux messages, buffer tronqué.
- Alignement `T − K` : un client privé de snapshots récents dégrade sans planter.

### 10.4 Ce qui reste manuel

Ouvrir deux onglets, lancer une vague, vérifier à l'œil que la horde **a l'air** d'une
horde : silhouettes distinguables, pas de marche au pas, tri en profondeur correct. C'est du
jugement, pas une assertion.

---

## 11. Risques

| Risque | Parade |
| --- | --- |
| **Divergence de direction** — le pire, car non bornée | Alignement `T − K` (§5), test à seuil (§10.1) |
| Un `WAVE_ORDER` perdu | TCP garantit la livraison (§7) ; noté car dépendant du transport |
| Atlas trop grand pour un GPU faible | 2048×2048 mesuré, contre 4096 de limite sûre |
| `ParticleContainer` incapable d'animer | Documenté comme supporté (`uvs`) — **à prouver par une tâche de spike en tête du plan**, avant d'écrire le reste du rendu |
| Le tri par bandes coûte trop cher | Le banc dit que le rendu a trois ordres de grandeur de marge |

---

## 12. Questions laissées ouvertes

- **`K` vaut-il vraiment 3 ticks ?** À confirmer en mesurant la dérive à différentes valeurs.
  Le test du §10.1 est l'outil pour trancher.
- **Le seuil de 2 px** est une valeur de départ, pas une mesure.
- **`MAP_SIZE` reste à 6 000.** L'étape 1 propose 10 000 (§15.2) ; l'agrandir avant d'avoir
  des vagues à y mettre ne prouverait rien. À rouvrir en fin d'étape 2.
