# Étape 17b — la synchro exacte : la horde du client rejoint celle du serveur

**Statut :** validée en conversation le 7 novembre (rejeu exact des vagues en retard ; test croisé
salon ↔ client accepté).
**Avant :** l'étape 18 (reconnexion), dont le plan devra être recalé (§7).

## 0. Pourquoi

Le bilan de l'étape 17 listait trois défauts antérieurs de la réplication de la horde. Le
diagnostic, mené avec un **vrai `Room` branché sur un vrai `GameClient`** (l'ordre réel des messages
de `Session#broadcast`, une latence de N ticks), montre que la situation est bien pire que prévu :

| Situation (graine `0xd1a6_0002`, niveau 6, 1 200 ticks) | Écart max du client | Entités perdues |
| --- | --- | --- |
| latence 0 | 1 547 – 3 482 px (dès t = 180) | 0 |
| latence 1 | 320 – 1 807 px | jusqu'à 2 |
| latence 2 et 3 | 816 – 2 412 px | jusqu'à 157 |

**Tous les tests « 0,000 px » existants copiaient l'ordre du client** dans leur référence au lieu de
celui de `Room#step` : aucun ne pouvait voir ces écarts. Avec les six correctifs ci-dessous, mesurés
ensemble sur le même banc, l'écart tombe à **0,000 px de la latence 0 à 3, sans aucune perte**.

Les dégâts restent arbitrés au serveur (`DEATHS` par identité) : ces écarts sont visuels, mais ils
se voient (ennemis qui glissent, qui disparaissent, qu'on vise à côté).

## 1. Les six défauts et leurs correctifs

### 1.1 L'ordre naissance / rafraîchissement du champ (serveur)

**Constat.** Dans `Room#step`, au tick `T` : déplacement des joueurs → **rafraîchissement des champs
et `retarget` si `T % STEPS_PER_FIELD === 0`** → **puis** naissance des vagues du directeur et des
proies (`#startEvent(seed, this.#tick)`) → `horde.step(T)`. Les petits du diviseur et du nécromancien
(`#spawnAt`, `spawnTick = T + 1`) sont insérés **à la fin de `T`**, donc avant le rafraîchissement de
`T + 1`. Le client, lui, fait toujours naître **avant** de rafraîchir. `PERIOD_TICKS = 180` est un
multiple de 3 : **chaque vague du directeur** tombe sur un tick de rafraîchissement. Mesuré à
latence 0 : 0,754 px au tick de naissance, 42 px trente ticks plus tard, 459 px vers t = 1 080.
Le commentaire de `room.ts` qui dit ce point vérifié par le scénario 9 de
`shared/horde.replication.test.ts` est faux (ce scénario fait naître une fois, avant sa boucle).

**Correctif.** Le serveur déplace le bloc de rafraîchissement **après** les naissances (directeur et
proies) : l'ordre devient celui que le client et tous les scénarios partagés supposent déjà. Aucun
octet. Effet de jeu : une entité née est reciblée à son tick de naissance (un porteur ou une proie
réagit tout de suite). Le docblock de `Room#step` (étapes 4 et 5 et l'avertissement) est réécrit ;
le commentaire `ponytail:` de `client.ts` sur cet écart disparaît.

### 1.2 Les ordres « du futur » appliqués trop tôt (client)

**Constat.** `#applyPendingOrders` prend tous les ordres en attente (`splice(0)`) et borne le retard à
`Math.max(0, tick − spawnTick)` : un ordre dont `spawnTick > tick` (un petit né à `T + 1`, reçu avant
que le client simule `T`, ou tout ordre reçu alors que l'horloge du client est en retard) naît un pas
trop tôt. Mesuré : 7 px sur le premier petit, jusqu'à 1 449 px.

**Correctif.** Les ordres dont `spawnTick > tick` restent dans la file ; seuls ceux dont
`spawnTick <= tick` sont appliqués, triés par `spawnTick`.

### 1.3 Les entités perdues après un rejeu (client)

**Constat.** Un ordre appliqué en retard naît au tick courant : il est absent de tous les
instantanés de `HordeHistory` antérieurs. Un rejeu ultérieur (morts, zones, charges, leurres, gel)
restaure un tick plus ancien et `#replayTick` ne le refait jamais naître : il est **perdu pour
toujours**. Touche les petits **et des vagues entières** (168 entités perdues mesurées à latence 2).

**Correctif.** Un journal des ordres appliqués (`#spawned`), élagué au-delà de
`ROLLBACK_DEPTH_TICKS`. Au début de `#replayTick(t)`, avant le rafraîchissement, les ordres du
journal dont `spawnTick === t` renaissent. Les ordres appliqués par le rejeu d'un lot en retard
entrent au journal **après** la boucle de rejeu (sinon ils naîtraient deux fois). L'ordre des
naissances dans un même tick suit `spawnTick` puis l'ordre d'arrivée, comme au serveur.

### 1.4 Le rattrapage des vagues en retard n'est jamais exact (client) — décision : rejeu exact

**Constat.** `spawnCatchingUp` (rattrapage des seules nouvelles entités, répulsion approchée) manque
les rafraîchissements et reciblages de sa fenêtre et sa répulsion approchée se propage : 1,1 px à
t = 366, 200 px à t = 925 à latence 1. C'est l'écart dominant dès 1 tick de latence.

**Correctif (décision de Léo, 7 novembre).** Toute vague en retard dont la fenêtre tient dans
l'historique passe par la restauration + le rejeu (le chemin que l'étape 17 réservait aux vagues
touchant un gel) ; `#freezeTouches` disparaît. **Un seul rejeu par image** : si le même lot apporte
des ordres en retard et des morts (ou zones, charges, leurres, gels) à rejouer, le rejeu part du
**plus ancien** tick concerné et applique tout en une passe. Le rattrapage léger ne sert plus qu'aux
ordres plus vieux que l'historique (perte connue, comptée comme les autres retards).

Ceci revient sur le ruling de performance de l'étape 17 (rejeu de la horde coûteux à 4 000
entités) : une vague en retard arrive au plus toutes les 6 s, et le rejeu des morts tourne déjà
presque à chaque tick en combat. Le coût est **mesuré** au portique (§5).

### 1.5 Deux snapshots dans la même image (client)

**Constat.** Le client n'enregistre dans son historique de positions que le dernier snapshot reçu
(`#buffer.latest()`) : quand deux arrivent dans la même image, l'aîné manque, et le
rafraîchissement qui lit `tick − FIELD_INPUT_DELAY_TICKS` tombe sur une autre ligne qu'au serveur
(1 064 px mesurés). Le serveur peut lui-même provoquer ce cas (deux `room.step` dans un rappel, un
seul snapshot).

**Correctif.** Chaque snapshot est enregistré **à son arrivée** (`#onFrame`, après
`#buffer.push`), pas seulement le dernier.

### 1.6 L'historique des joueurs pendant un gel (serveur)

**Constat.** Les trois retours anticipés de `Room#step` pendant un gel (portail, étalage,
`#freezeUntilTick`) sautent `#history.record`. Après le dégel, `delayed()` lit la dernière ligne
d'avant le gel — son jeu de joueurs, son tick, ses leurres — alors que le client a enregistré
chaque snapshot gelé. Mesuré (gel d'étalage) : départ d'un joueur 73,9 px, arrivée 7,9 px, leurre
posé juste avant le gel 64,7 px **sans départ ni arrivée**.

**Correctif.** L'enregistrement de fin de pas devient `#recordHistory()`, appelé aussi avant les
trois retours gelés (pas celui de `#runOver`). Serveur seul, aucun octet.

## 2. Ce qui ne change pas

- Aucun message nouveau, aucun octet de plus ; formats inchangés.
- `sampleDirection` (`shared/flowfield.ts`) n'est pas touché.
- Les règles de jeu (vagues, directeur, gel, portail) ne changent pas, hors l'effet du §1.1 (une
  entité née est reciblée à son tick de naissance).

## 3. Le test qui voit enfin : salon ↔ client

`front/src/net/room-client.replication.test.ts` (décision de Léo : l'import de `back/src/room` par un
test du front est accepté, **dans ce seul fichier de test**). Un vrai `Room` branché sur un vrai
`GameClient` par une fausse socket qui reproduit l'ordre des messages de `Session#broadcast`, avec
une latence de N ticks. L'écart se mesure **par identité d'entité**, une fois tout reçu pour le tick
comparé (« écart réglé ») ; les entités manquantes ou en trop comptent comme des échecs.

Scénarios, chacun à **0,000 px et 0 perte** :

1. latence 0, 1, 2, 3, sur au moins 1 200 ticks avec plusieurs vagues sur des ticks de
   rafraîchissement, des morts, des diviseurs et des nécromanciens ;
2. un hoquet d'une image sur les ticks qui émettent des petits (snapshots et morts en retard d'une
   image) ;
3. un gel d'étalage avec, dans trois variantes, un départ, une arrivée, un leurre posé juste avant ;
4. un portail traversé (« rester »).

Ce test est **rouge aujourd'hui** sur chaque scénario ; chaque correctif doit en faire passer au
moins un, et le test lui-même doit rougir si l'on retire n'importe lequel des six correctifs
(contre-épreuves).

Tests unitaires en plus : ordre `Room#step` (rafraîchissement après naissance) dans
`back/src/room.test.ts` ; `room.tick − fieldInputTick === FIELD_INPUT_DELAY_TICKS` au premier
rafraîchissement après un dégel ; ordre du futur gardé en file, petit né dans le même lot que la mort
de son parent présent après rejeu, deux snapshots dans une image, un seul rejeu par image quand un
lot apporte ordres et morts, dans `front/src/net/client.test.ts`. Le test existant de
`client.test.ts` qui exige « pas de rejeu pour une vague ordinaire en retard » s'inverse.

## 4. Risques

- **Coût du rejeu** : mesuré au portique. Si une image dépasse le budget à 4 000 entités, le
  plafond se note (`ponytail:`), le prochain levier étant de ne rejouer que jusqu'au tick courant
  du serveur.
- **Ordre des naissances dans un tick rejoué** : le journal et le lot courant doivent se fusionner
  par `spawnTick` ; un ordre différent du serveur se verrait au test croisé.
- Un ordre plus vieux que `ROLLBACK_DEPTH_TICKS` reste approché (même limite que les morts en
  retard) ; il est compté.

## 5. Le portique

Tests complets, bancs, et une **mesure du coût client** : temps du rejeu par image dans le test
croisé à 4 000 entités (ou au banc `bench:sep`, colonne rejeu), à comparer au budget d'une image à
60 Hz. Le bilan note les chiffres.

## 6. Vérification manuelle

- en coop à deux sur deux machines (ou deux onglets), la horde se voit-elle au même endroit des deux
  côtés au fil d'une longue run ?
- les petits d'un diviseur apparaissent-ils toujours chez les deux joueurs ?
- un porteur de coffre ou une proie qui vient de naître réagit-il tout de suite (effet du §1.1) ?

## 7. Effet sur l'étape 18

L'étape 18 (reconnexion) lit les lignes d'historique `T−5…T` pendant un gel : elles n'existent
qu'avec le §1.6. Son plan est à recaler après cette étape : l'enregistrement de fin de pas vit dans
`#recordHistory()` (tâche 3) ; la vérification « dernière ligne = tick courant, portail ou étalage
ouvert » ne passe qu'avec le §1.6 (tâche 4) ; son test à 0,000 px gagne à passer par le banc salon ↔
client (tâche 6). `PRESENCE` et `SNAPSHOT(T)` devront porter le même jeu d'absents pour le tick `T`,
sinon le défaut du §1.5 revient.
