# Étape 9 — la roue de ping : résultats

**Spec :** [`../specs/2026-10-15-etape-9-ping.md`](../specs/2026-10-15-etape-9-ping.md)
**Plan :** [`2026-10-15-etape-9-ping.md`](2026-10-15-etape-9-ping.md)

Un joueur maintient le clic droit, choisit une intention parmi quatre (*viens*, *danger*, *boss*,
*je prends*), et ses alliés voient le ping dans le monde, sur la mini-carte, et par une flèche en
bord d'écran s'il est hors champ. Le même indicateur pointe en permanence vers chaque allié hors
écran. **Zéro octet de plus par tick.**

⚠️ **Ce document est ouvert.** Le §5 attend la run de l'auteur.

## 1. Le livrable

`back/src/ping.integration.test.ts` — **6 tests**, sur vraies sockets, observés à travers le
décodage uniquement :

| Ce qui est asséné | Comment |
| --- | --- |
| le ping de B arrive chez A **et** chez B, intention et position intactes | `PING_SHOWN` décodé des deux côtés |
| le 4ᵉ ping en moins de 2 s est coupé, et ça repasse après la fenêtre | trois `x` reçus exactement, puis un 4ᵉ après 2,1 s |
| une intention inconnue n'arrive jamais | sentinelle valide derrière elle |
| une position hors carte arrive bornée | `(-500, MAP_SIZE + 3000)` → `(0, MAP_SIZE)` |
| rien ne passe en salle d'attente | aucun `PING_SHOWN` |
| un joueur qui revient sur le même id ne récupère pas la fenêtre du précédent | 3 pings, déconnexion, reconnexion, 1 ping accepté |

## 2. Le coût sur le fil

| Message | Sens | Octets |
| --- | --- | --- |
| `PING: 26` | client → serveur | 6 |
| `PING_SHOWN: 27` | serveur → tous | 7 |

Rien n'entre dans `SNAPSHOT`. Au pire, trois pings par joueur et par deux secondes à quatre
joueurs : ≈ 170 o/s en pointe. `Room` n'est pas modifié : l'anti-spam vit dans la `Session`.

## 3. Écarts au plan et à la spec

- **Les flèches de bord sont en Pixi, pas en canevas 2D** (§6.3 de la spec). Le HUD est en DOM ;
  les flèches vont dans un calque en coordonnées écran posé sur `app.stage`, au-dessus du monde.
  Conséquence acceptée : elles suivent la secousse de caméra, comme tout le reste de l'image.
- **Un test client retiré** (tâche 3) : il redisait le test de datation et n'assertait rien
  d'autre. L'expiration au gel est épinglée par `livePings` (`ping-renderer.test.ts`).
- **`pingWheel` est créé avant `client.connect()`** dans `main.ts`, pour écarter tout accès avant
  déclaration depuis la lambda de visée.
- **Fait sur une branche** (`etape-9-ping`), pas sur `main` : `main` recevait au même moment des
  modifications en direct sur `client.ts` et `room.ts`.

## 4. Le portique

Lancé seul, sur `etape-9-ping` :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| lint des fichiers de l'étape | vert (3 avertissements CSS antérieurs, `noDescendingSpecificity`, lignes de l'étape du 14 octobre) |
| tests front | 686 passent, **1 échoue** |
| tests back | 1359 passent, **1 échoue**, **1 fichier ne charge pas** |

**Les trois échecs et les deux erreurs de lint sont antérieurs à l'étape 9**, vérifiés en les
rejouant sur le commit de départ `9cbb06a`, où ils échouent à l'identique :

- `front/src/ui/draft.test.ts` — attend « Éventail », remplacé par le tir circulaire (`5b946c7`) ;
- `back/src/elements-5b.integration.test.ts` — `arme introuvable au catalogue : Éventail`, même cause ;
- `back/src/elements-5c.integration.test.ts` — « six paires d'un joueur seul » expire à 60 s ;
- `biome` : imports non triés dans `front/src/ui/icons.test.ts`, format de `front/src/ui/settings.test.ts`.

Aucun de ces fichiers n'est touché par l'étape 9.

## 5. Vérification manuelle — ouverte

À regarder pendant la run, ce que les tests ne peuvent pas juger :

- la roue est-elle lisible et rapide en pleine horde ?
- la visée figée pendant la roue gêne-t-elle ?
- les flèches permanentes vers les alliés sont-elles envahissantes à quatre ?
- les quatre sons se distinguent-ils ?
- sur un pavé tactile de Mac, le clic droit maintenu est-il praticable ? Sinon, les touches 1 à 4
  sont la réponse prévue (§9 de la spec), sans toucher au fil.

## 6. Notes de revue laissées pour plus tard

Rien de bloquant ; chaque tâche a passé sa revue sans correction.

- plusieurs `PING_SHOWN` dans la même image ne jouent que le son du dernier ;
- le menu contextuel reste neutralisé en pause et pendant l'étalage tant que le HUD est affiché ;
- la fenêtre glissante de l'anti-spam est écrite en ligne dans `#onFrame` — à extraire si un
  second appelant apparaît.
