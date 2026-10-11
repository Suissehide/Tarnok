# Étape 7b — la boutique : l'or achète enfin quelque chose

**Livrable :** un joueur dépense son or, et sa run suivante en est changée — mesurable, et prouvé sur
vraies sockets.

L'étape 7a a donné un compte, un solde, et la garantie que l'or survit. Elle n'a donné **aucune façon
de le dépenser**. C'est ce trou que 7b comble, et rien d'autre.

## 1. Ce que l'étape change au jeu

Trois choses apparaissent :

1. une **boutique** à l'écran d'accueil, où l'or achète des articles ;
2. **six armes verrouillées** — une par élément — qui se débloquent et entrent dans le pool du draft ;
3. des **améliorations permanentes** de statistiques de départ, qui s'appliquent à chaque run.

### 1.1 Ce que l'étape NE vend PAS, et c'est la décision la plus importante de la spec

**Jamais de slot d'arme.** Le §11 de la spec d'orientation liste les « slots » parmi ce que l'or
achète. **Pris au mot, cet article détruit la mécanique centrale du jeu**, et le calcul est
immédiat :

| Slots d'armes | Paires couvertes par un joueur **seul** |
| --- | --- |
| 4 (aujourd'hui) | 6 sur 15 |
| 5 | 10 sur 15 |
| **6** | **15 sur 15 — toutes** |

La première phrase du README — « un joueur seul ne peut pas couvrir assez d'éléments pour tout
déclencher lui-même » — **meurt à six slots**. Et c'est la phrase que l'étape 5c a rendue
*testable* : `elements-5c.integration.test.ts` assène « quatre slots, six paires, jamais quinze ».

**Le §11 est donc amendé par cette spec** : les slots d'armes ne sont pas vendables, et ne le seront
pas. `WEAPON_SLOTS` reste une constante.

⚠️ **Les slots de passifs ne sont pas vendus non plus.** Ils seraient sans danger pour le pitch — un
passif ne porte aucun élément — mais `PASSIVE_SLOTS` est consommé par `Loadout`, dans `shared/`, et
le rendre variable par compte toucherait exactement le code qu'on vient d'écarter. Hors périmètre,
sans regret.

### 1.2 Et les classes ?

Le §11 nomme aussi les « **classes supplémentaires** au-delà des quatre de départ ». **Elles
n'existent pas.** `shared/classes.ts` est absent du dépôt, et le §15.1 — qui demandait de trancher
leur nombre et leurs verbes « **avant l'étape 3** » — n'a jamais été tranché. Le jeu a traversé les
étapes 3 à 7a sans classes.

Il n'y a donc **rien à débloquer** de ce côté, et 7b ne prétend pas le contraire. Les déblocages de
cette étape sont les six armes, et elles seules.

## 2. La boutique

### 2.1 Le catalogue vit dans `shared/`, les prix sont appliqués par le serveur

`shared/shop.ts` déclare les articles : identifiant, libellé, prix, effet, nombre de niveaux. Le front
l'importe pour **afficher** la boutique — une seule source de vérité pour les libellés et les prix.

Mais **aucun prix n'est lu depuis le client**. Acheter est un `POST` ; le serveur relit le prix dans
le catalogue, vérifie le solde, débite et insère la ligne, **dans une seule transaction**. Un client
ne peut pas plus fabriquer un achat qu'il ne pouvait fabriquer de l'or — c'est l'autorité serveur du
§11, appliquée au même endroit.

### 2.2 Une seconde table : `Purchase`

```prisma
model Purchase {
  accountId String
  itemId    String
  level     Int      @default(1)
  createdAt DateTime @default(now())

  account   Account  @relation(fields: [accountId], references: [id], onDelete: Cascade)

  @@id([accountId, itemId])
}
```

Une ligne par article possédé, `level` pour les articles à paliers. La clé composite interdit
structurellement le doublon.

⚠️ **`level` n'a de sens que pour les améliorations.** Un déblocage d'arme est binaire : sa ligne
existe ou n'existe pas, et son `level` vaut toujours `1`. Le catalogue déclare donc, pour chaque
article, son **nombre de paliers** — `1` pour un déblocage — et le serveur refuse un achat qui
dépasserait ce nombre.

**Les deux alternatives, examinées et écartées :**

| Approche | Pourquoi non |
| --- | --- |
| Des colonnes sur `Account` (`hpLevel`, `speedLevel`, `unlockedWeapons Int[]`) | **Une migration par article ajouté** à la boutique. Avec une table, ajouter un article ne touche que `shared/shop.ts` |
| Une colonne `Json` unique | Non validée, non interrogeable, et le schéma cesse de décrire ce qu'il contient |

### 2.3 Les prix sont un RÉGLAGE DE JEU, pas un invariant

⚠️ **Aucun test ne doit écrire un prix en dur.** Les assertions se dérivent du catalogue ou le
comparent — même doctrine que le docblock de `REACTION_DAMAGE`.

**L'ancre, faute de données.** L'étape 7a n'a livré **aucun historique de runs** (décision assumée de
sa §5), donc il n'existe aucune mesure de ce qu'une run rapporte réellement. L'ancre est donc
calculée depuis les constantes : une extraction au palier `k` verse
`GOLD_PER_PALIER_BASE × hpScale(k)` plus les pièces ramassées. Le premier article doit coûter
**environ une extraction réussie à un palier précoce**. Les chiffres exacts sont à régler au playtest,
et la spec le dit plutôt que de prétendre les avoir équilibrés.

## 3. Les six armes verrouillées

### 3.1 Lesquelles, et pourquoi celles-là

Le dépôt porte **17 armes**, dont exactement **deux par élément** plus cinq neutres. Et le motif est
parfaitement régulier : dans chaque élément, l'une est un **arroseur** (multi-projectiles, cadence
rapide, dégâts faibles) et l'autre un **frappeur** (projectile unique, cadence lente, gros dégâts).

| Élément | Arroseur (libre) | Frappeur (verrouillé) |
| --- | --- | --- |
| Braise | éventail (n=5) | **grenade** (n=1) |
| Givre | flèches-jumelles (n=2) | **sceptre-arcanique** (n=1) |
| Foudre | bobine-tesla (n=2) | **canon-à-arc** (n=1) |
| Poix | seringue-à-poix (n=3) | **chaudron-à-poix** (n=1) |
| Chaux | poire-à-chaux (n=3) | **canon-à-chaux** (n=1) |
| Vif-argent | fronde-à-mercure (n=2) | **glaive-de-mercure** (n=1) |

**C'est le frappeur qu'on verrouille**, pour deux raisons : un gros coup unique se vit comme une
récompense, et les arroseurs appliquent les éléments **plus souvent**, ce qui convient mieux à un
compte qui découvre le système de réactions.

⚠️ **Chaque élément garde une arme libre.** Un compte neuf atteint donc toujours les six éléments, et
les **quinze réactions restent accessibles** — l'étape 5c n'est pas affaiblie.

Aucune arme neuve n'est créée. 7b est une étape de **systèmes**, pas de contenu.

### 3.2 Le verrou est un champ EXPLICITE, pas une règle dérivée

`Weapon` gagne `locked: boolean`. Les six frappeurs le portent.

⚠️ **Bien que `projectileCount === 1` les désigne exactement aujourd'hui, on ne dérive pas.** C'est la
leçon payée à l'étape 5c : j'y avais dérivé la liaison du Vif-argent d'une propriété du nibble, le
correctif a dépassé la cible, et il a fallu revenir à un champ explicite sur trois réactions. Une
règle dérivée qui coïncide avec les données d'aujourd'hui est la **première forme du « décor qui
masque »** — une valeur égale à une constante de production, donc une égalité qui ne prouve rien.

### 3.3 Le verrou ferme le POOL DU DRAFT, pas le `Loadout`

`drawSpread` tire sur **l'union** des pools de la salle. Le serveur **refuse** un jeton de draft posé
sur une carte que ce joueur n'a pas débloquée — une condition de plus dans `setDraftToken`, qui
arbitre déjà (« le client PROPOSE, le salon arbitre »).

**Conséquence voulue :** `Room#grantCard` n'est pas concerné. Les tests qui équipent une arme
directement — dont le livrable de 5c, qui le fait onze fois — restent verts sans être touchés.

**Et l'arbitrage du §7.2 en hérite** : le perdant d'un conflit repioche parmi ce qui reste **et**
qu'il peut prendre.

### 3.4 Pourquoi l'union, et pas l'intersection

| Approche | Conséquence |
| --- | --- |
| **Intersection** (seulement ce que tous ont débloqué) | **Un débutant dégraderait le pool de toute l'équipe.** Le §8.1 l'interdit en propres termes : « le jeu doit rendre le regroupement **rentable**, jamais **obligatoire** », et « une punition se lit comme un bug » |
| **Union sans grisage** (chacun peut tout prendre) | Le déblocage profiterait à toute la salle, donc la valeur de l'achat personnel s'effondrerait — pourquoi payer si un ami l'a déjà ? |
| **Union + grisage** | Retenue |

### 3.5 Le grisage ne coûte AUCUN octet

Le client connaît **son propre** ensemble d'armes débloquées, lu en HTTP au chargement comme son
solde : `GET /accounts/me` rend désormais `{ gold, purchases }` plutôt que `{ gold }` seul — une
route de plus serait un second aller-retour pour la même information, au même instant. Il grise donc pour lui-même, et **rien de neuf ne transite** : `DRAFT_OPEN` ne bouge pas.

Envoyer un masque d'éligibilité aurait permis de montrer à chacun ce que **les autres** peuvent
prendre — mais rien dans le jeu ne demande cette information, et ça coûterait des octets.

## 4. Les améliorations permanentes

### 4.1 Elles réutilisent un mécanisme qui existe déjà

`Room` somme déjà `CONSTANTE + loadout.bonus(clé)` à **cinq endroits**, pour cinq clés :
`fireRate`, `damage`, `maxHp`, `speed`, `regen`. Son propre docblock dit que le plafond de vie est
« borné par `maxHp`, **jamais par `PLAYER_MAX_HP`** ».

Une amélioration permanente est donc **exactement de la même forme qu'un passif, déjà câblé**. Le
design se réduit à sommer un terme de plus aux mêmes endroits :

```
CONSTANTE + loadout.bonus(clé) + compte.bonus(clé)
```

**Aucune constante à paramétrer, aucun `Loadout` à toucher, aucun concept neuf.**

⚠️ **Une amélioration achetée ne consomme AUCUN slot de passif.** C'est un terme distinct, pas une
carte.

### 4.2 Et une sixième clé : le rayon de ramassage — la seule qui coûte cher

Le document de résultats de l'étape 6a laisse une question ouverte : « **le rayon de ramassage punit
chaque gain de puissance** — tuer plus loin laisse le butin plus loin. Décision de l'auteur. »

Un rayon achetable est la réponse à cette question, et l'auteur l'a tranchée : **on le vend.** Une
sixième clé de bonus, `pickupRadius`, s'ajoute aux cinq existantes.

⚠️ **Mais celle-là n'est PAS câblée, et c'est la seule.** Le §4.1 vaut pour les cinq clés existantes ;
il ne vaut pas pour celle-ci. `ORB_PICKUP_RADIUS` est lu comme une **constante globale** à deux
endroits — `OrbField#resolvePickups` (`back/src/combat.ts:211`) et `DerivedOrbs#capture`
(`front/src/net/client.ts:277`) — et **aucun des deux ne connaît de valeur par joueur**.

La rendre personnelle demande donc **quatre** points de contact nouveaux :

1. une valeur par joueur dans `Room`, sommée comme les cinq autres ;
2. `resolvePickups` qui compare au rayon **du joueur considéré**, et non à un `r2` unique ;
3. le `SNAPSHOT` qui la transporte (§5) ;
4. `capture` côté client qui lise celle de chaque joueur.

**C'est donc l'article le plus coûteux de la boutique, sur les deux axes à la fois** : du code neuf
*et* des octets sur le fil. Les cinq autres sont presque gratuites. Si le périmètre devait se
resserrer en cours de route, **c'est elle qu'il faudrait retirer en premier** — et le §5 disparaîtrait
avec elle, ce qui rendrait à l'étape son « zéro octet par tick ».

## 5. Le coût affiché de l'étape : l'invariant « zéro octet par tick » tombe

⚠️ **C'est la conséquence la plus lourde de 7b, et elle est assumée. Elle se lit ici, pas au banc.**

`ORB_PICKUP_RADIUS = 90` est lu **des deux côtés**. Le client prédit la capture dans
`DerivedOrbs#capture`, et son docblock dit pourquoi c'est licite : client et serveur comparent « les
**mêmes** positions répliquées au **même** rayon ». Il dit aussi ce qui serait illicite — une capture
qui se déclencherait sans ramassage réel « **mentirait** ».

Or `capture(players, …)` boucle sur **tous** les joueurs. Si le rayon devient personnel, prédire le
ramassage d'un coéquipier avec son propre rayon serait exactement ce mensonge.

**Décision : le rayon de chaque joueur voyage dans le `SNAPSHOT`.**

`SNAPSHOT_PLAYER_BYTES` passe de **9 à 10**.

| | Aujourd'hui | Après |
| --- | --- | --- |
| `SNAPSHOT`, 4 joueurs | 22 + 4 × 9 = **58** octets | 22 + 4 × 10 = **62** octets |
| Par client, 4 joueurs, 30 Hz | — | **+120 octets/s** |
| Par salon de quatre | — | **+0,47 ko/s** |

**La proportion compte, et c'est elle qui rend la décision défendable** : l'architecture du §3.3 a
économisé ~150 ko/s en ne répliquant pas les positions de la horde. Ce surcoût en représente
**0,3 %**.

**Pourquoi un `u8`, et c'est calculé, pas devine** : la base vaut 90, le plafond d'un octet non signé
est 255, donc il reste **165 px de marge** pour les améliorations. La somme
`ORB_PICKUP_RADIUS + <bonus maximal du catalogue>` doit rester ≤ 255, et **un test l'assène en dérivant
le maximum du catalogue** — pas en écrivant 255 en dur à côté d'un chiffre choisi au hasard.

⚠️ **L'alternative écartée, et son coût réel** : ne prédire que pour soi aurait coûté **zéro octet**,
au prix d'une orbe ramassée par un coéquipier qui s'animerait un aller-retour plus tard. C'était de la
finition perdue sur un détail que l'étape 6a avait justement travaillé. L'auteur a préféré payer en
octets.

## 6. Comment les achats atteignent une run

À la poignée de main, le serveur résout déjà `accountId` depuis le `HELLO`. Il charge ensuite les
achats du compte et les applique à l'état de départ du joueur.

### 6.1 Le risque, nommé parce que c'est là que 7a a saigné

⚠️ **Cela ajoute un SECOND `await` sur le chemin de `HELLO`** — exactement la frontière asynchrone
dont les **quatre défauts Critiques** de l'étape 7a sont tous nés, dont **deux tuaient le process
entier** (un listener `'error'` retiré, une promesse flottante sans `.catch`).

Les gardes existent désormais, et elles sont testées : `ws.readyState !== ws.OPEN` après l'`await`,
`#stopped` pour la session morte, un `libere` idempotent, un `.catch` sur la promesse, et le retrait
du listener de premier message **avant** tout point de suspension.

**Le plan devra exiger que tout nouvel `await` reste à l'intérieur de ces gardes**, et le vérifier
plutôt que de l'espérer. Un seul `await` ajouté au mauvais endroit rouvre les quatre.

### 6.2 Un échec de chargement ne doit pas refuser la partie

Si la lecture des achats échoue, le joueur entre **sans ses améliorations** plutôt que de ne pas
entrer. L'or n'est pas perdu — il est en base — et la run suivante les retrouvera. Refuser la
connexion pour une panne de lecture punirait le joueur d'un incident serveur.

## 7. Vérification

**Le livrable :** acheter une amélioration, démarrer une run, et **mesurer** qu'elle s'applique.

| Ce qui est asséné | Pourquoi ça ne peut pas être creux |
| --- | --- |
| Un achat débite **exactement** le prix du catalogue, et le solde est relu depuis la base | assertion **dérivée** du catalogue, jamais un prix en dur |
| Un achat à solde **insuffisant** est refusé, et **rien** n'est débité ni inséré | la transaction est le mécanisme ; un test qui ne vérifierait que le refus laisserait passer un débit partiel |
| Une amélioration achetée **change la run** : le maximum de vie du joueur vaut `PLAYER_MAX_HP + bonus`, mesuré sur vraie socket | la mutation « ignorer le bonus du compte » rougit |
| Une arme verrouillée est **refusée par le serveur**, pas seulement grisée côté client | un test purement client prouverait le grisage, pas le verrou |
| Un compte neuf atteint **les six éléments et les quinze réactions** | la mutation « verrouiller les deux armes d'un élément » rougit |
| `ORB_PICKUP_RADIUS + bonus maximal ≤ 255` | dérivé du catalogue, donc un article trop généreux ajouté plus tard fait rougir ce test au lieu de déborder l'octet |
| `SNAPSHOT_PLAYER_BYTES` vaut **10**, et le `SNAPSHOT` à quatre joueurs fait **62** octets | épinglés en **chiffres nus** — une assertion contre la constante serait vraie quoi qu'il arrive |
| `ZONE`, `REACTION` et `DRAFT_OPEN` **inchangés**, octet par octet | le seul élargissement du fil est celui qui est écrit au §5 |
| Un achat concurrent du même article depuis deux onglets ne débite **qu'une fois** | la clé composite et la transaction sont les mécanismes ; à exercer, pas à raisonner |

⚠️ **La réplication ne se mesure PAS ici.** Établi à l'étape 6a et revérifié à 5c : le décor d'un test
d'intégration balaie la horde par `Horde.kill`, qui court-circuite volontairement le lot `DEATHS`. Les
chiffres de dérive vivent dans `shared/horde.replication.test.ts`.

## 8. Écarts assumés

- **Le `SNAPSHOT` grossit de 4 octets à quatre joueurs** (§5). Sept étapes sans un octet ajouté par
  tick s'arrêtent ici, par décision explicite.
- **Les prix ne sont pas équilibrés**, faute d'historique de runs. Réglage de playtest.
- **Pas de slot vendable**, ni d'arme, ni de passif (§1.1).
- **Pas de classe**, puisqu'il n'en existe aucune (§1.2). Le §15.1 reste ouvert, et il bloquera un
  jour une étape qui voudra les vendre.
- **Pas de remboursement, pas de remise à zéro.** Un achat est définitif. Rien dans le §11 ne demande
  autre chose, et une annulation demanderait de décider ce qu'elle rend.
- **Un achat n'est pas annonçable en cours de run** : les améliorations s'appliquent à la **run
  suivante**, parce qu'elles sont lues à la poignée de main. C'est voulu — changer les statistiques
  d'un joueur en pleine partie demanderait de les faire voyager.
- **`POST /accounts` n'a toujours aucun plafond par IP** (écart hérité de 7a).

## 9. Questions laissées ouvertes

- **Combien de paliers par amélioration, et quelle courbe de prix ?** À régler au playtest, avec les
  quatre runs qui sont déjà dues.
- **Le §15.1 — les classes.** Toujours pas tranché, et c'est maintenant la seule partie du §11 qui
  n'a aucun chemin d'implémentation.
- **Faut-il montrer aux autres joueurs ce qu'on a débloqué ?** Le grisage est privé dans cette étape.
  Un étalage qui montrerait « deux joueurs peuvent prendre cette carte » rendrait la négociation du
  §7.1 plus riche, au prix d'octets.
