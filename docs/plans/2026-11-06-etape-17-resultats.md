# Étape 17 — l'extraction retravaillée : résultats

**Spec :** [`../specs/2026-11-06-etape-17-extraction.md`](../specs/2026-11-06-etape-17-extraction.md)
**Plan :** [`2026-11-06-etape-17-extraction.md`](2026-11-06-etape-17-extraction.md)

Le vote d'extraction **gèle le monde**, comme l'étalage. Il s'affiche en **carte compacte au
centre** : deux boutons, un montant d'or chacun, les pastilles des votants. Les touches **1** et
**2** votent. **Aucun message nouveau, aucun octet de plus.**

⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur.

## 1. Le livrable

`back/src/portal.integration.test.ts`, étape 17, sur deux vraies sockets :
- un portail s'ouvre ;
- pendant le vote, les `SNAPSHOT` montrent un monde immobile (joueurs et horde) alors que les
  entrées continuent d'arriver ;
- deux « rester » ferment le portail **avant** l'échéance ;
- le monde repart après la reprise progressive.

Contre-épreuve faite et annulée : sans le garde du portail dans `Room#step`, le test rougit
(`le joueur 1 bouge : expected { x: 2481, y: 2880 } to deeply equal { x: 2880, y: 2880 }`).

## 2. Ce qui est livré

| Pièce | Où |
| --- | --- |
| le portail gèle le monde ; « rester » reprend comme un étalage ; un étalage dû attend le verdict ; « partir » l'abandonne ; les verbes refusés pendant le vote | `back/src/room.ts` |
| le gel du client **daté au tick du serveur** et rejoué s'il arrive en retard (étalage **et** portail) | `front/src/net/client.ts` |
| badge « Portail — pause… », l'étalage précédent effacé à l'ouverture | `front/src/ui/hud.ts`, `front/src/net/client.ts` |
| la carte compacte (520 px, voile léger) | `front/src/ui/portal.ts`, `front/index.html`, `front/src/styles/main.css` |
| les touches 1 et 2 (Ctrl, Cmd, Alt, Échap et bilan les bloquent) | `front/src/ui/portal.ts`, `front/src/main.ts` |

## 3. Le coût

- **Sur le fil** : rien. Le client tire le début du gel de `PORTAL_OPEN`
  (`deadlineTick − PORTAL_WINDOW_TICKS + 1`) et la fin de `PORTAL_RESULT.effectTick`.
- **Côté client** :
  - un rejeu d'au plus 8 ticks par gel ou dégel reçu en retard ;
  - une vague en retard ne rejoue la horde que si un gel ou sa reprise touche sa fenêtre, donc au
    plus une fois par étalage ou portail ;
  - les autres gardent le rattrapage léger d'avant.

## 4. Écarts au plan et à la spec

- **Le défaut trouvé par le plan** : le client gelait à la **réception** de `LEVEL_UP`, pas au
  tick daté, et rien ne rejouait le gel. Mesure : horde arrêtée au tick 20 au lieu de 200.
  Corrigé pour l'étalage comme pour le portail : écart de 529,8 px avant, **0,000 px** après.
- **Réconciliation** avec la passe interfaces (`3c1b007`), commitée pendant l'écriture du plan :
  - `Portal#forget` gardé ;
  - le refus des verbes étendu au portail ;
  - `inert` sous le menu Échap ;
  - les apostrophes typographiques.
- **Tâche 2, revue** :
  - un gel reçu en retard ressuscitait un ennemi tué au tick d'avant : l'historique est
    réenregistré au tick de mort ;
  - la vague du tick d'ouverture dérivait : elle est rejouée.
- **Tâche 2, ruling de performance** : un premier correctif rejouait toute la horde pour chaque
  vague en retard, soit presque toutes, à environ 7 à 14 ms par lot à 4 000 entités. Ce rejeu
  est restreint aux vagues qui touchent un gel.
- **Revue finale** : trois commentaires disaient encore que le vote ne gèle rien (dont la doc
  de `PortalOpenMessage` dans `shared/protocol.ts`, **commentaire seul**, format inchangé).
  S'y ajoutent les modificateurs sur 1 et 2, `<kbd>` caché aux lecteurs d'écran et une
  allocation par tick en moins.
- **Portique** : `back/src/server.test.ts`, le test du multiplicateur au second portail, tuait
  toute la horde par `horde.kill` jusqu'à l'ouverture. Le boss né dans la vague qui ouvre le
  portail mourait hors du chemin du salon, alors gelé, et le palier suivant ne tombait jamais.
  Le test épargne désormais le boss et relève le joueur.

**Défauts antérieurs trouvés, laissés hors de l'étape** (à traiter à part) :
- **Ordre naissance / recalcul du champ** : le serveur fait naître les vagues du directeur
  **après** le recalcul du champ de leur tick, le client avant. Écart d'environ 4 px, seulement
  quand une vague sort sur un tick de recalcul. Commentaire `ponytail:` dans `client.ts`.
- **Petits perdus** : les petits d'un diviseur ou d'un nécromancien disparaissent côté client
  quand la mort du parent et leur ordre arrivent dans la même image avec 1 tick de retard ou
  plus.
- **Départ ou arrivée pendant un gel** : le serveur cesse d'enregistrer `PlayerHistory` pendant
  un gel, le client non. Un départ ou une arrivée pendant le portail peut donc faire dériver les
  premiers recalculs de champ après le gel. Même racine que la lacune du §6 de la spec, que
  l'étape 18 traite.

**Plafonds connus** :
- **Un seul gel précédent mémorisé** : si trois gels sont annoncés avant que la horde du client
  ait passé le premier (choix très rapides, onglet en arrière-plan), les ticks du premier se
  lisent comme non gelés.
- **Gel reçu trop tard** : au-delà de 8 ticks de retard, il n'est pas rejoué. Le compteur
  `lateFreezes` le signale.

## 5. Le portique

Lancé seul, sur `etape-17-extraction` :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| tests front | **877 / 877** |
| tests back | **1708 / 1708** |
| lint | 0 erreur, 3 avertissements CSS antérieurs |

**Bancs** :
- `bench:sim` : pas p95 ≈ 1,7 ms de 250 à 4 000 entités, tout `OK` ;
- `bench:net` : 66 / 176 / 286 o par snapshot pour 4 / 14 / 24 entités, inchangés ;
- `bench:sep` : verdicts identiques à `main` (« à borner » et « rouvrir le §3.2 » au-delà de
  500 entités, antérieurs).

**Dérive** :
- `shared/horde.replication.test.ts` : 46 / 46 ;
- les huit scénarios de portail de `client.test.ts` (à l'heure, en retard de 2 à 5 ticks,
  ouverture sur un tick de recalcul ou non, étalage enchaîné) : **0,000 px**.

## 6. Vérification manuelle — ouverte

- la carte se lit-elle d'un coup d'œil, sans masquer le jeu au point de perdre le fil ?
- 1 / 2 au clavier : naturel, ou en conflit avec un autre geste ?
- la reprise après « rester » est-elle confortable ?
- après « rester », le titre « L’équipe reste » ne se voit qu'une ou deux images avant que la
  carte disparaisse : faut-il le garder affiché un instant ?
- un joueur absent bloque l'équipe jusqu'à 20 s : trop long ?
- le portail n'est plus une source de tension : ça manque ?
