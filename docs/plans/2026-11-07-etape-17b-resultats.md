# Étape 17b — la synchro exacte : résultats

**Spec :** [`../specs/2026-11-07-etape-17b-synchro-exacte.md`](../specs/2026-11-07-etape-17b-synchro-exacte.md)
**Plan :** [`2026-11-07-etape-17b-synchro-exacte.md`](2026-11-07-etape-17b-synchro-exacte.md)

La horde du client rejoint celle du serveur à **0,000 px, sans aucune entité perdue**, de la latence
0 à 3, à travers les gels, les absences, les rechargements, un portail, un hoquet réseau et un
rattrapage du serveur. **Aucun message nouveau, aucun format changé** ; le seul surcoût sur le fil
est le retour au débit nominal d'un snapshot par tick (§3).

⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur.

## 1. Le livrable

`front/src/net/room-client.replication.test.ts` : un vrai `Room` branché sur un vrai `GameClient`
par une fausse socket qui reproduit `Session#broadcast`, avec N ticks de latence. L'écart se mesure
**par identité d'entité**, sur un tick entièrement reçu. Les entités manquantes ou en trop font
échouer le test, et un nombre minimal de ticks mesurés est exigé.

**Quatorze scénarios** (douze du plan, deux ajoutés en revue) :
- latence 0, 1, 2, 3 ;
- hoquet d'une image ;
- cinq variantes de gel d'étalage : départ, arrivée, leurre, absence, rechargement ;
- portail à latence 0 et 2 ;
- **rattrapage du serveur** : trois pas, un seul envoi ;
- **client une image derrière la livraison**.

| Avant (à `44e4e9b`) | Après |
| --- | --- |
| 139 à 5 567 px, jusqu'à 1 830 entités perdues | **0,000 px, 0 perdue, sur les 14** |

**Huit contre-épreuves** : chaque correctif retiré seul, puis restauré.

| Correctif retiré | Ce qui rougit |
| --- | --- |
| §1.1 naître avant de rafraîchir (serveur) | les 13 scénarios d'alors (992 à 5 567 px) |
| §1.2 ordres du futur | latence 0 (54,6 px) |
| §1.3 journal des ordres | latences 1-3 et portail latence 2 (460 à 1 830 perdues), hoquet (1 339 px), rattrapage |
| §1.4 rejeu exact des vagues en retard | latences 1-3, portail latence 2, rattrapage |
| §1.5 chaque snapshot à son arrivée | hoquet (1 064,7 px), rattrapage (1 000,6 px) |
| §1.6 historique pendant le gel (serveur) | les 5 gels (7,9 à 73,9 px) |
| un snapshot par pas (serveur) | `server.test.ts`, test du coup de frein du process : trou de ticks `[8, 14]` |
| rejeu borné après un saut d'horloge | `client.test.ts` : 994 pas en une image au lieu de ≤ 9 |

Sans le correctif des **morts du futur** (vague finale), le scénario « une image derrière » rougit
(53 px, 128 perdues). Sans celui des **charges du futur**, il marque 0,570 px.

## 2. Ce qui est livré

| Pièce | Où |
| --- | --- |
| naissances (directeur, proies) **avant** le rafraîchissement du champ ; `#recordHistory()` aussi sur les trois retours gelés | `back/src/room.ts` |
| **une diffusion après chaque `room.step`**, rattrapage compris (un snapshot par tick) | `back/src/server.ts` |
| historique enregistré à la réception de chaque snapshot ; ordres, morts et charges du futur qui attendent leur tick | `front/src/net/client.ts` |
| journal `#spawned` et **un seul rejeu par pas** (`#replayLate`) pour ordres, morts, zones, charges, leurres, gels ; rejeu borné à l'anneau, anneau vidé sur un saut d'horloge | `front/src/net/client.ts` |
| compteur `lateOrders`, lecture de test `hordeAt`, remise à neuf au `RESYNC` (anneau, journal, gel différé, lignes vides gardées) | `front/src/net/client.ts` |
| `holds` / `clear` | `shared/horde-history.ts` |

## 3. Le coût

**Sur le fil** :
- aucun message nouveau, aucun format changé ;
- le serveur envoyait en réalité **moins** d'un snapshot par tick. Son minuteur d'envoi dérivait de
  celui de la simulation : 75 envois pour 90 pas mesurés en 3 s, et la moitié des ticks sans
  snapshot propre. Il diffuse désormais après chaque pas, ce qui rétablit le débit nominal
  (`SNAPSHOT_HZ = TICK_HZ`). Test de trafic de `server.test.ts` : 2 607 → 2 970 o en 3 s (+14 %),
  exactement le débit prévu par ce test.

**Au client**, coût d'une image qui rejoue : (1 + n) × pas, avec un pas à 4 000 entités de 3,51 ms
en formation dense et 1,93 ms en formation lâche (`bench:sep`).

| Retard | n | Dense | Lâche | Budget à 60 Hz |
| --- | --- | --- | --- | --- |
| vague, L = 1 | 2 | 10,5 ms | 5,8 ms | 16,7 ms |
| vague, L = 2 | 3 | 14,0 ms | 7,7 ms | |
| vague, L = 3 | 4 | 17,6 ms | 9,7 ms | |
| pire (anneau entier) | 7 | 28,1 ms | 15,4 ms | |

- **Au-delà du budget** : le pire cas en formation dense (L ≥ 3, ou après un hoquet) dépasse une
  image. C'est noté en `ponytail:` sur `#replayLate` ; le prochain levier est de ne rejouer que
  jusqu'au tick courant du serveur.
- **Comparé à avant** : une mort en retard coûtait déjà (1 + L) pas, et plusieurs rejeux pouvaient
  s'enchaîner dans un même pas. Il n'y en a plus qu'un. Le coût vraiment nouveau est le rejeu d'une
  vague en retard sans mort dans le même pas, au plus une fois toutes les 6 s.

## 4. Écarts au plan et à la spec

- **Un rejeu par pas, pas par image** : quand une image fait plusieurs pas, chaque pas a le sien,
  mais le premier prend tout ce qui est arrivé. Les gels ne rejouent plus à la réception.
- **Journal** : les ordres en retard entrent au journal **avant** le rejeu et ne naissent que par
  lui.
- **Ordre plus vieux que l'anneau** : il naît après le pas, par rattrapage, et vide l'anneau. C'est
  compté dans `lateOrders`, et ce chemin dégradé contourne la garde
  `assertFieldsNotRefreshed`.
- **Banc, graine et exemption** : graine de latence `0xd1a6_0005`, parce que `0xd1a6_0002` ne fait
  naître aucun diviseur. Les petits datés de T+1, insérés en fin de T, ne comptent pas comme
  manquants.
- **Réconciliation avec l'étape 18**, commitée pendant l'écriture du plan :
  - remise à neuf au `RESYNC` ;
  - le banc suit la diffusion actuelle (`RESYNC`, `PRESENCE`) ;
  - deux variantes de gel en plus (absence, rechargement).
- **Ajouts de revue** :
  - **Scénario 13, rattrapage du serveur** : il a révélé les snapshots manquants. Correctif :
    diffuser après chaque pas (Ruling 4). Le banc mesure le dernier tick complet.
  - **Rejeu borné après un saut d'horloge** : un onglet caché en combat faisait jusqu'à 994 pas en
    une image.
  - **Morts et charges du futur** : elles attendent désormais leur tick, et le scénario « une image
    derrière » le vérifie.
  - **Lignes d'historique vides du `RESYNC`** : elles sont gardées pour les ticks > 0, comme au
    serveur.
- **Fusion** : `main` a reçu l'étape 19 (pseudo, rejouer ensemble) pendant l'exécution. Il a été
  fusionné dans la branche avant le portique ; le seul conflit était l'import des constantes de
  `server.ts` (`SNAPSHOT_HZ` retiré, `REPLAY_HOLD_MS` gardé).
- **Étape 17** : les « Défauts antérieurs » de son bilan sont refermés ici. Ses lignes sur le
  rattrapage léger des vagues, le ruling de performance et l'« écart d'environ 4 px » sont désormais
  fausses ; ce document d'historique n'est pas modifié.

**Limites connues, que le banc ne voit pas** :
- le **saut d'horloge** après un gel du navigateur (le banc avance en pas égaux) ;
- les **zones, charges et leurres sous latence**, couverts seulement par des tests unitaires ;
- la **mort d'un joueur** (le banc garde les joueurs en vie) ;
- le correctif des **charges du futur** n'a pas de test unitaire propre, seul le banc le voit ;
- les compteurs `late*` (sauf `lateDeaths`) ne s'affichent pas dans le HUD.

## 5. Le portique

Lancé seul, sur `etape-17b-synchro` **après fusion de `main`** (étape 19 comprise) :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| tests front | **955 / 955** |
| tests back | **1788 / 1788** |
| lint | 0 erreur, 3 avertissements CSS antérieurs |

- **Un échec isolé** au premier passage : `room.test.ts`, « gele le monde a la montee de niveau ».
  Vert seul trois fois, puis vert sur une seconde exécution complète. Le test crée un `Room` sans
  graine, donc il se comporte comme un test instable, antérieur à l'étape.
- **Bancs** :
  - `bench:sim` : pas p95 ≈ 1,65 ms jusqu'à 4 000 entités, tout `OK` ;
  - `bench:net` : 66 / 176 / 286 o par snapshot, inchangés. Sa deuxième partie affiche toujours
    0 ko/s par joueur, comme à l'étape 16 : défaut du banc ;
  - `bench:sep` : verdicts inchangés.

## 6. Vérification manuelle — ouverte

- en coop à deux sur deux machines (ou deux onglets), la horde se voit-elle au même endroit des deux
  côtés au fil d'une longue run ?
- les petits d'un diviseur apparaissent-ils toujours chez les deux joueurs ?
- un porteur de coffre ou une proie qui vient de naître réagit-il tout de suite ?
- couper le Wi-Fi d'un joueur pendant un étalage et revenir avant la fin : la horde saute-t-elle au
  dégel ?
- grosse horde en formation dense : la page tient-elle ses images quand un rejeu tombe (le pire cas
  mesuré dépasse une image) ?
