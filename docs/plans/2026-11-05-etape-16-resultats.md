# Étape 16 — les événements bonus, deuxième fournée : résultats

**Spec :** [`../specs/2026-11-05-etape-16-evenements-2.md`](../specs/2026-11-05-etape-16-evenements-2.md)
**Plan :** [`2026-11-05-etape-16-evenements-2.md`](2026-11-05-etape-16-evenements-2.md)

Quatre événements rejoignent les sceaux, la forge et le convoi : **Le siège** (tenir un totem
45 s cumulées, à 150 px au plus), **La relique** (la porter jusqu'à l'autel, lent et sans tirer),
**La chasse** (abattre trois proies qui fuient), **Le noir** (survivre 40 s dans la nuit, groupés
autour de la lanterne). Sept genres équiprobables, un bit solo, **aucun message nouveau, aucun
octet de plus par tick**.

⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur.

## 1. Le livrable

`back/src/evenement.integration.test.ts` — vraies sockets, observées à travers le décodage, à côté
des trois tests de l'étape 14 (7 / 7) :

1. **la relique** : même porteur chez les deux, date `D + 1` (à 4 ticks près, identique chez les
   deux), 60 % de la vitesse au serveur, aucune salve pendant le portage, livraison → étalage
   épique ;
2. **le noir** : les PV hors de la lumière baissent dans les `SNAPSHOT`, lanterne tombée →
   détruit, aucun étalage ;
3. **la chasse** : trois `WAVE_ORDER` de proies avant le même `EVENT_START` (17 o), toutes
   tombées → étalage ;
4. **le siège** : sans défenseur la progression reste nulle, cinq ennemis abattent le totem —
   aucun étalage.

Contre-épreuves faites et annulées (chacune rougit le test) :

| Règle cassée | Échec observé |
| --- | --- |
| garde `holdsFire` de `#fireWeapons` | `expected 6 to be 1` (le porteur tire à six ticks) |
| facteur de vitesse du porteur | `expected 1 to be close to 0.6` |
| drainage du noir | `expected 0 to be greater than or equal to 2` |
| chasse sans proie forcée | `EVENT_START (joueur 2) : rien en 3000 ms` |
| `EVENT_STATE` hors cadence au changement de porteur | `expected 14 to be less than 11` (assertion d'ordre ; la tolérance de 4 ticks absorbe la date) |

## 2. Ce qui est livré

| Pièce | Où |
| --- | --- |
| sept genres, bit solo `0x80`, octet porteur | `shared/evenements.ts`, `shared/protocol.ts` |
| la proie (gnoll ×1,6, 160 PV, 195 px/s, fuite partagée avec le porteur de coffre) | `shared/archetypes.ts`, `shared/horde.ts` |
| placement sur vraies cartes, règles pures des quatre genres, `EventRun#forget` | `back/src/evenement.ts` |
| le salon : départ, pas, porteur, drainage, naissance des proies | `back/src/room.ts` |
| règle partagée du porteur : `fireCooldown`, `lastFireAfterCarry`, `CarrierClock` | `shared/firing.ts`, `shared/evenements.ts` |
| miroir client, datation du porteur, `eventTargets` | `front/src/net/client.ts` |
| bandeaux et HUD | `front/src/ui/` |
| sol : totem, relique, autel, anneau rouge des proies | `front/src/render/behavior-renderer.ts` |
| obscurité (trou `cut()`, bord doux, fondu) ; mini-carte vide | `front/src/render/darkness-renderer.ts`, `front/src/ui/minimap.ts` |
| flèches vers chaque cible | `front/src/render/ping-renderer.ts` |

## 3. Le coût sur le fil

**Aucun message nouveau, aucun octet de plus par tick.**

- `EVENT_START` : 5 o (noir), 9 o (siège), 13 o (relique, chasse solo), 17 o (chasse) ;
- `EVENT_STATE` : 7 o × 5 Hz, plus 7 o par changement de porteur de relique ;
- `SNAPSHOT` inchangé ;
- les proies : 2 ou 3 `WAVE_ORDER` ordinaires par chasse.

## 4. Écarts au plan et à la spec

Les 19 écarts assumés du plan (base, graines multiples de 7, datation `tick + 1` hors pas,
`#spawnAt` qui rend un id, relique dans `cart`, recalage sur la dernière salve, `CarrierClock`
partagé, lectures de test, drapeau lu avant la cadence, `eventTargets` pur, `EventView` à champs
obligatoires, tests existants retouchés, dérive mesurée sur la proie, lignes du README, datation à
4 ticks près sur sockets, reprise du tir prouvée sur la chute, bord doux inversé, `inDark` qui
porte le solo, `minimapEnemies`). Ce que l'exécution a changé en plus :

- **Ruling 2** — `main` avancé en avance rapide sur `etape-15-progression` avant de brancher.
- **Tâche 7** — un événement relique qui se termine pendant le portage, appris en retard, sautait
  le recalage du tir : la libération passe aussi par `CarrierClock` au `SNAPSHOT` suivant.
- **Revue finale** :
  - **appris en avance** (même famille) : le client tire avant le serveur pour l'ancien porteur.
    `#relicCarrierAt` consulte la relique terminée jusqu'à `E` ;
  - **un porteur qui part** (`leave`) pendant un gel : un nouveau venu pouvait hériter de son id
    et de la relique ou de la lanterne. `EventRun#forget` lâche la relique et éteint la lanterne
    aussitôt ;
  - **la mini-carte pendant le noir** cache aussi le porteur de coffre (`minimapPorteur`) ;
  - **un commentaire de `combat.ts`** corrigé : `hurtPlayer` n'est plus seul à baisser les PV.
- **Portique** — `back/src/server.test.ts` gardait une graine multiple de 3, qui tirait la chasse
  au lieu de la forge (écart n° 2 incomplet) : corrigée.
- **Laissé, connu** :
  - un joueur arrivé en cours de run qui ramasse la relique n'a pas de miroir : il prédit à pleine
    vitesse et se fait recaler (§10 de la spec, pas de rattrapage) ;
  - sous le drainage du noir, les PV affichés (entiers) peuvent montrer 0 jusqu'à ~15 ticks avant
    la mort ;
  - une chasse dans une horde presque pleine envoie ses trois `WAVE_ORDER`, le client les tronque
    comme le serveur ;
  - la datation du porteur glisse jusqu'à 4 ticks sous rattrapage (cosmétique).

## 5. Le portique

Lancé seul, sur `etape-16-evenements` :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| tests front | **847 / 847** |
| tests back | **1693 / 1693** |
| lint | 0 erreur, 3 avertissements CSS antérieurs |

**Bancs** (aucun ne démarre d'événement) :
- `bench:sim` : pas p95 ≈ 1,7 ms de 250 à 4 000 entités, tout `OK` (budget 11,11 ms) ;
- `bench:net` : 66 / 176 / 286 o par snapshot pour 4 / 14 / 24 entités répliquées.
  La partie 2 affiche 0 ko/s par joueur, **à l'identique sur `main`** : défaut du banc, antérieur.

**Dérive répliquée** (`shared/horde.replication.test.ts`) :

| Scénario | Proie | Horde |
| --- | --- | --- |
| PR1, sans rejeu | 27,186 px | 35,288 px |
| PR2, avec rejeu | **0,000 px** | **0,000 px** |

## 6. Vérification manuelle — ouverte

- les quatre événements se lisent-ils d'un coup d'œil (totem, relique, anneau rouge, nuit) ?
- **le siège** :
  - 45 s cumulées dans 60, avec ~5 s de marche : tenable ?
  - 600 PV de totem, trop ou pas assez ?
  - la présence exigée à 150 px rend-elle bien le « siège » ?
- **la relique** :
  - 1 500 px à 156 px/s, soit ~10 s de marche ;
  - le porteur muet est-il protégé ou abandonné ?
  - le Relais d'un porteur (téléportation avec la relique) : astuce ou triche ?
- **la chasse** :
  - des proies à 195 px/s et 160 PV au niveau 1 (≈ 377 au niveau 10), trois en 60 s : le rythme
    est-il juste ?
  - les proies survivantes qui restent dans la horde gênent-elles ?
- **le noir** :
  - 0,9 d'obscurité : lisible sans être frustrant ?
  - les arbres visibles se remarquent-ils ?
  - 2 PV/s pousse-t-il à rester groupé ?
  - les chiffres de dégâts au-dessus du noir trahissent-ils trop la horde ?
  - le bord doux (quatre anneaux `cut()`) rend-il bien, sinon repli `NOIR_FEATHER_PX = 0` ?
- sept genres équiprobables : un genre revient-il trop souvent pour son intérêt ?

Risques à surveiller (§12 de la spec) :
- la datation qui repose sur l'ordre d'envoi ;
- une salve de trop au ramassage tardif (cosmétique) ;
- les proies d'une chasse ratée qui restent dans la horde.
