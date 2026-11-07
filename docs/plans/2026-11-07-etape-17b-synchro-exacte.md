# Étape 17b — la synchro exacte : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** la horde du client rejoint **exactement** celle du serveur — 0,000 px et 0 entité perdue
de la latence 0 à 3, un hoquet d'une image, un gel d'étalage avec départ, arrivée, leurre, absence
ou rechargement de page, un portail traversé — sans un octet de plus sur le fil.

**Architecture :** au serveur, deux déplacements dans `Room#step` : le rafraîchissement des champs
passe **après** les naissances (directeur, proies), et l'enregistrement de l'historique des joueurs
devient `#recordHistory()`, appelé aussi par les trois retours gelés. Au client, chaque snapshot
entre à l'historique **à son arrivée** ; seuls les ordres **de ce tick** naissent en tête de pas
(ceux du futur attendent, ceux du passé vont au journal `#spawned`) ; et **un seul rejeu par pas**,
`#replayLate`, ramasse en fin de pas tout ce qui est arrivé en retard (ordres, zones, charges,
leurres, morts, gel), repart **une fois** du plus ancien tick concerné, refait naître les ordres du
journal à leur tick (`#replayTick`) et tue chaque lot de morts à son tick. Un banc qui branche un
vrai `Room` sur un vrai `GameClient` (`front/src/net/room-client.replication.test.ts`) mesure tout
cela par identité d'entité.

**Pile :** TypeScript, Vitest, Biome. Aucune base pour les tâches 1 à 5 (`Room` est sans E/S) ;
Postgres seulement au portique (tâche 6).

**Spec :** [`docs/specs/2026-11-07-etape-17b-synchro-exacte.md`](../specs/2026-11-07-etape-17b-synchro-exacte.md)
(validée le 7 novembre ; le diagnostic et ses correctifs mesurés sont repris tels quels, sauf le
rejeu unique, conçu ici — voir l'écart n° 1).

**Où l'on travaille :** dans un worktree `../Tarnok-synchro`, sur une branche `etape-17b-synchro`
créée depuis `main`. Les ancres `l.N` sont celles de `44e4e9b` (l'étape 18 commitée ; le plan,
écrit à `252ab47`, y a été recalé — voir « Réconciliation avec l'étape 18 »).

```bash
git worktree add ../Tarnok-synchro -b etape-17b-synchro main
cd ../Tarnok-synchro && npm ci && npm run db:generate -w back
cp ../Tarnok/back/.env back/.env && cp ../Tarnok/front/.env front/.env
```

Tout le code de ce plan a été écrit et mesuré dans un worktree jetable avant d'être recopié ici,
**puis rejoué sur `44e4e9b`** : les 12 scénarios du banc passent à 0,000 px avec les quatre tâches,
chaque contre-épreuve de la tâche 5 en fait rougir au moins un, et les fichiers de test existants
cités passent.

## Réconciliation avec l'étape 18 (44e4e9b)

Écrit à `252ab47`, rejoué de bout en bout sur `44e4e9b` (étape 18 commitée) dans un worktree jetable : les dix scénarios d'origine passent de rouge (mêmes écarts que le tableau de la tâche 1) à 0,000 px / 0 perdue, les deux nouveaux aussi, chaque contre-épreuve rougit les mêmes scénarios aux mêmes chiffres. Une ligne par changement :

1. **Ancres** recalées sur `44e4e9b` (`room.ts`, `client.ts`, `client.test.ts`, `room.test.ts`, `server.ts`) ; `shared/horde-history.ts`, `back/src/combat.ts`, `shared/horde.ts` l.1009-1011, `shared/horde.replication.test.ts` inchangés.
2. **Rien de l'étape 17b n'était déjà fait** : les trois retours gelés n'enregistrent rien (`back/src/room.ts` l.1468-1497 ; « un tick gele n'en fait pas », `front/src/net/client.ts` l.2966-2968) et le client n'enregistre que le DERNIER snapshot (`client.ts` l.3136-3142) — aucune partie de tâche retirée.
3. **Tâche 2** : `#recordHistory()` déplace le bloc avec le filtre `p.hp > 0 && !p.absent` (`room.ts` l.1992-1993), plus de conditionnel ; `room.test.ts` 191 → 193 tests.
4. **Tâche 2, spec §7** : le test du dégel vérifie que `room.resyncState().history` porte six lignes non vides pendant le gel (`room.ts` l.2062-2065 lit `#history.at(t)`) — rouge à `44e4e9b` (`[ [], [], [], [], [], [] ]`).
5. **Tâche 3** : l'étape 18 filtre déjà les absents à la réception (`#lastPositions`, `client.ts` l.2865-2875, champ l.1429-1434) ; la tâche 3 le remplace par `#history.record` direct, même filtre, et supprime le champ — `PRESENCE` (hors diffusion, `server.ts` l.256, l.362) et `SNAPSHOT(T)` portent ainsi le même jeu d'absents (spec §7).
6. **Tâche 4, étape 9 bis** : `#onResync` (`client.ts` l.3005-3006) vide l'anneau avant d'y poser `T`, vide `#spawned`, oublie `#freezeReplayFrom` — un onglet revenu (`RESYNC_REQUEST`, `e334be4`) a pu simuler au-delà de `T` ; test « un RESYNC repart a neuf », rouge sans (`expected 10 to be +0`).
7. **Tâche 4, `#pendingOrders` au `RESYNC`** : le vidage existant (`client.ts` l.3067) reste, ordres du futur compris (le salon ne draine que des petits à `T + 1`, déjà dans sa horde de `T`) ; commentaire seulement.
8. **Tâche 4, étape 10** : la référence du `RESYNC` (`client.test.ts` l.5692-5712, l.5793-5794) recopiait l'ancien ordre « champ, vagues, horde » et citait le `ponytail:` supprimé ; ordre vagues → champ → horde, commentaire réécrit, toujours 0 px (mesuré).
9. **Comptes** : `client.test.ts` 158 → 161 (tâche 3) → 167 (tâche 4) ; étape 2 de la tâche 4 : 8 échecs au lieu de 7.
10. **Tâche 1, banc** : `drainLikeServer` recopie `Session#broadcast` tel qu'il est (`server.ts` l.639-767 : `RESYNC` après tous les drains, avant le snapshot) ; `before` reçoit un `send` hors diffusion pour `PRESENCE`.
11. **Tâche 1, deux variantes de gel d'étalage** (spec §7) : `absence` (`setAbsent` + `PRESENCE` à 450) et `resync` (absent à 430, client neuf rechargé à 450, latence 0) — rouges à `44e4e9b` (139,536 px), vertes après la tâche 2, rouges sans le §1.6 (73,886 px) ; dix scénarios → douze.
12. **Chiffres** : à `44e4e9b` sans correctif, 18 ordres / 137 morts par scénario de latence (17 / 128 dès la tâche 2) ; tous les écarts px du plan d'origine retrouvés à l'identique.
13. **Suite, hors de ce plan** : rechargement à latence non nulle et `RESYNC_REQUEST` sur le même client dans le banc (il faudrait recaler l'horloge du banc après le saut du client) ; le test du point 6 couvre la remise à neuf.

## Contraintes globales

- **Aucun message nouveau, aucun octet de plus.** `shared/protocol.ts` n'est pas touché ; les
  formats de `WAVE_ORDER`, `DEATHS`, `SNAPSHOT`, `ZONE`, `BOSS_CHARGE`, `ABILITY_USED`, `LEVEL_UP`,
  `DRAFT_RESULT`, `PORTAL_OPEN`, `PORTAL_RESULT` ne changent pas.
- **Jamais toucher `sampleDirection`** (`shared/flowfield.ts`).
- Les règles de jeu ne changent pas, hors l'effet voulu du §1.1 : une entité née est reciblée à son
  tick de naissance (un porteur ou une proie réagit tout de suite).
- Constantes inchangées : `ROLLBACK_DEPTH_TICKS = 8`, `FIELD_INPUT_DELAY_TICKS = 3`,
  `PERIOD_TICKS = 180`, `TICK_HZ = 30`, `FLOWFIELD_HZ` (un rafraîchissement tous les 3 pas).
- **Un seul test du front importe `back/src/room`** : `front/src/net/room-client.replication.test.ts`
  (décision de Léo, spec §3). Rien d'autre du front n'importe `back/`.
- Commentaires de code en français **sans accents** ; messages de commit conventionnels en
  français sans accents, sujet en minuscules (`fix(back): ...`, `fix(front): ...`,
  `test(front): ...`, `docs: ...`). Les commentaires rendus faux par ce plan sont **réécrits**,
  jamais laissés faux (liste à la tâche 4).
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa tâche**,
  **au premier plan** (`npx vitest run <fichier>`) — jamais `npm test`, jamais un banc, jamais une
  commande en arrière-plan. Le portique complet et les bancs sont au contrôleur, **seul**, à la
  tâche 6.
- Commandes de test : back depuis `back/` (`cd back && npx vitest run src/...`), front depuis
  `front/` (`cd front && npx vitest run src/...`).
- **Postgres partagé** (tâche 6 seulement) : un échec isolé de compte ou d'or à 0 dans un test
  d'intégration se **relance une fois** avant d'en conclure quoi que ce soit.
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>`.
- **Des commits NOUVEAUX seulement** : jamais `--amend`, `rebase`, `reset`, `stash`, ni `checkout`
  d'un autre commit.
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.
- Aucun actif nouveau (dépôt public, actifs sur MinIO).

## Points de vigilance de la revue

1. **Des ordres qui arrivent alors que l'horloge du client est en retard sur le salon** (juste après
   le `WELCOME`, ou les petits `spawnTick = T + 1` reçus avant que le client simule `T`) : ils
   attendent leur tick, et naissent sans pas rattrapé → test « un ordre du futur reste en file »,
   tâche 3.
2. **Une mort et un ordre en retard dans la même image, à des ticks différents** (dans les deux
   sens : l'ordre plus ancien, puis la mort plus ancienne) : un seul rejeu depuis le plus ancien,
   la victime morte, la vague présente → test « un lot qui apporte un ordre et une mort », tâche 4.
3. **Un rejeu qui traverse le début d'un gel** (une vague en retard et le `LEVEL_UP` qui gèle
   pendant sa fenêtre, livrés ensemble) : un seul rejeu, la vague née à son tick et gelée avec le
   monde → test « une vague en retard dont la fenêtre croise le début d'un gel », tâche 4.
4. **Un ordre plus vieux que `ROLLBACK_DEPTH_TICKS`** : il naît au présent, compté dans
   `lateOrders`, et aucun rejeu ultérieur ne le perd → test « un ordre plus vieux que l'anneau »,
   tâche 4.
5. **Deux snapshots dans la même image pendant un gel** : la ligne du tick gelé entre quand même
   à l'historique, et le premier rafraîchissement après le dégel lit la même ligne qu'au salon →
   test « deux snapshots dans la même image (gel : true) », tâche 3.
6. **Un `RESYNC` sur un client qui a simulé au-delà de `T`** (onglet revenu, étape 18 bis) : ni
   l'anneau ni le journal d'avant ne ressuscitent quoi que ce soit → test « un RESYNC repart a
   neuf », tâche 4.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `front/src/net/room-client.replication.test.ts` (créé) | le banc salon ↔ client, 12 scénarios (tâche 1), basculés de `it.fails` à `it` par les tâches 2 à 4 |
| `back/src/room.ts` | rafraîchissement après les naissances, `#recordHistory()` et les trois retours gelés, docbloc de `step` (tâche 2) ; un commentaire (tâche 4) |
| `back/src/room.test.ts` | l'ordre naissance → reciblage, le premier rafraîchissement après un dégel et l'historique du `RESYNC` pendant le gel (tâche 2) ; trois commentaires (tâche 4) |
| `front/src/net/client.ts` | `hordeAt` (tâche 1) ; ordres du futur, snapshot à l'arrivée à la place de `#lastPositions` (tâche 3) ; journal, `#replayLate`, `lateOrders`, remise à neuf au `RESYNC` (tâche 4) |
| `front/src/net/client.test.ts` | ordre du futur, deux snapshots (tâche 3) ; journal et rejeu unique, `RESYNC` qui repart à neuf, deux tests existants modifiés, la référence du `RESYNC` (étape 18) remise à l'ordre du salon, deux commentaires (tâche 4) |
| `shared/horde-history.ts` | `holds(tick)`, `clear()` (tâche 4) |
| `back/src/combat.ts`, `shared/horde.replication.test.ts` | commentaires qui nommaient `#drainPendingDeaths` / `#applyDeaths` (tâche 4) |
| `docs/plans/2026-11-07-etape-17b-resultats.md` (créé), `README.md` | le bilan (tâche 6) |

Pourquoi ce découpage : le **banc** (1) d'abord, rouge, pour que chaque correctif prouve ce qu'il
répare en basculant ses scénarios ; le **serveur** (2) se relit seul (un ordre de pas, un
enregistrement) ; au client, les deux correctifs **locaux** (3 : une file, une ligne d'historique)
avant la **refonte des rejeux** (4), la seule tâche difficile ; le **livrable** (5) prouve que
chaque correctif compte ; le **portique** (6) au contrôleur.

## Écarts assumés

**Écart n° 1 — le rejeu unique est conçu ici, pas repris du diagnostic.** Les correctifs mesurés à
0,000 px (`client-early-late-slog.diff` du diagnostic) gardaient la séquence de l'étape 17 : un
rejeu pour les ordres en tête de pas, puis un par zone, charge, leurre et lot de morts en fin de
pas, et un par gel **à la réception** (`#replayFrom`, `front/src/net/client.ts` l.4293-4306,
appelé depuis `#onFrame`). La spec (§1.4) exige un seul rejeu. Conception retenue, mesurée aux
mêmes 0,000 px :
- en tête de pas, `#applyPendingOrders` ne fait plus naître que les ordres **de ce tick** ;
- en fin de pas, `#replayLate(tick, dt)` pose d'abord tout ce qui ne dépend pas de la horde (zone,
  charge, leurre, ordre au journal, bornes du gel déjà posées à la réception) et prend le **plus
  ancien** tick à restaurer, puis restaure **une fois**, rejoue jusqu'au présent, tue chaque lot de
  morts à son tick ;
- `#replayFrom` ne rejoue plus à la réception : il note `#freezeReplayFrom`, consommé par le
  prochain `#replayLate`.

Conséquences : plus aucun ordre d'application entre zones, charges et morts (les deux docblocs
« APPELE AVANT `#drainPendingDeaths` » disparaissent avec les fonctions) ; « un seul rejeu par
image » se lit **un par pas** — `update()` fait jusqu'à cinq pas par image (`client.ts`
l.2475-2486), mais tout ce qui est arrivé avant l'image est consommé par le premier, et les pas
suivants n'ont plus rien à rejouer.

**Écart n° 2 — un ordre en retard entre au journal AVANT le rejeu, pas après.** La spec (§1.3)
écrit que les ordres appliqués par le rejeu d'un lot entrent au journal « après la boucle de rejeu
(sinon ils naîtraient deux fois) ». Ici, ils ne naissent **que** par le journal (`#replayTick`) :
aucune boucle ne les fait naître à part, donc aucun double. L'effet est celui de la spec.

**Écart n° 3 — un ordre plus vieux que l'anneau naît en FIN de pas, et vide l'anneau.** L'ancien
chemin (`client.ts` l.4225-4239) le faisait naître en tête de pas avec `tick − spawnTick` pas
rattrapés ; il naît maintenant après le pas, avec `tick + 1 − spawnTick` pas (le pas `tick` vient
d'être fait sans lui) — même nombre de pas simulés. Puis `HordeHistory#clear()` : sinon le rejeu
suivant (presque chaque pas en combat) restaurerait un tick d'avant sa naissance approchée et le
perdrait pour toujours (`#replayTick` ne refait naître que les ordres exacts du journal ; refaire
naître l'approché buterait sur le garde de `Horde#spawnCatchingUp`, `shared/horde.ts`
l.1009-1011, juste après l'amorce du champ). Le prix : les retards des quelques pas suivants sont
appliqués au présent et comptés. Nouveau compteur `lateOrders` (spec §1.4 : « comptée comme les
autres retards »). Le test existant « calcule un rattrapage non nul » (`client.test.ts` l.195-247)
attend donc `3` pas au lieu de `2`, et `lateOrders === 1`.

**Écart n° 4 — `GameClient#hordeAt(tick, into)`, une lecture de test.** Le banc doit comparer
l'anneau du client au tick réglé ; `#hordeHistory` est privé. Une méthode d'une ligne
(`this.#hordeHistory.restore(tick, into)`), de même statut que `lateDeaths`. Ajoutée à la tâche 1.

**Écart n° 5 — le banc ne compte pas comme manquants les petits pas encore nés.** Au salon, un
petit de `spawnTick = T + 1` est inséré **à la fin de `T`** (`#spawnAt`) : l'état serveur de fin de
`T` le porte déjà, le client le fait naître en tête de `T + 1`. Comparer `T` les compterait perdus
à tort (mesuré : 3 faux « perdus » sur 1 200 ticks, à des ticks isolés). Le banc ignore, au tick
comparé `t`, les identités dont l'ordre est daté `> t`.

**Écart n° 6 — la graine des scénarios de latence est `0xd1a6_0005`, pas `0xd1a6_0002`.** Le
diagnostic utilisait `0xd1a6_0002` ; sur 1 200 ticks au niveau 6 elle ne sort **aucun** diviseur
(mesuré : 0 ordre `SPLIT_CHILD`, 3 `NECRO_CHILD`). `0xd1a6_0005` en sort 2 et 11, et la spec (§3)
exige diviseurs **et** nécromanciens. Le hoquet garde `0xd1a6_0002` (5 hoquets mesurés).

**Écart n° 7 — aucun scénario témoin.** Aucun scénario non trivial ne passe aujourd'hui : chaque
vague du directeur tombe sur un rafraîchissement (`PERIOD_TICKS = 180`), et un banc sans vague ne
compare que des hordes vides.

**Écart n° 8 — « chaque correctif fait passer au moins un scénario » se lit par tâche ; la
nécessité de chacun, par contre-épreuve.** Mesuré : la tâche 2 (§1.1 + §1.6) fait passer les trois
gels d'étalage et le portail à latence 0 ; la tâche 3 (§1.2 + §1.5), la latence 0 ; la tâche 4
(§1.3 + §1.4), le reste. Mais le §1.5 seul ne fait passer aucun scénario (le hoquet attend aussi le
journal), et les cinq gels d'étalage attendent le §1.1 **et** le §1.6. Que chacun des six compte est
prouvé à la tâche 5 : on le retire, au moins un scénario rougit (mesuré pour les six, à `252ab47`
puis à `44e4e9b`).

**Écart n° 9 — les commentaires « un seul lot de morts par tick, sinon le rejeu client
efface… »** (`back/src/combat.ts` l.833-835, l.1767-1770 ; `back/src/room.ts` l.1824-1827 ;
`back/src/room.test.ts` l.2794-2796, l.3173-3175, l.3278-3279) : la règle du salon reste (un
`DEATHS` par tick), mais sa raison ne vaut plus — `#replayLate` trie les lots et les tue chacun à
son tick dans un seul passage. Ces phrases sont réécrites à la tâche 4, la règle gardée.

**Écart n° 10 — une mort datée du futur du client reste « trop vieille ».** Une mort de tick
`D > tick` (client en retard sur le salon) n'est pas tenue par l'anneau : elle est appliquée au
présent et comptée dans `lateDeaths`, comme avant l'étape 17b. La spec ne traite que les ordres
(§1.2) ; le banc ne produit pas ce cas. Le `RESYNC` (étape 18) est le seul chemin qui recule
l'horloge du client : il vide l'anneau (réconciliation, point 6), sans quoi l'anneau tiendrait
encore ce futur, périmé.

**Écart n° 11 — deux scénarios de plus que la spec (§3), pour l'étape 18 (§7).** `absence` et
`resync` dans la famille des gels d'étalage (réconciliation, point 11) : douze scénarios au lieu
de dix.

**Écart n° 12 — `#onResync` remis à neuf (tâche 4).** La spec ne le demande pas (elle précède le
`RESYNC`) ; sans lui, le journal et l'anneau d'un onglet revenu ressuscitent des entités
(réconciliation, point 6).

---

### Tâche 1 : le banc salon ↔ client

**Fichiers :**
- Créer : `front/src/net/room-client.replication.test.ts`
- Modifier : `front/src/net/client.ts` (une méthode après le getter `lateFreezes`, l.1973-1975)

**Interfaces :**
- Consomme : `Room` (`back/src/room.ts` : `join`, `debugSetLevel`, `applyInput`, `debugSetHp`,
  `maxHpOf`, `positionOf`, `step`, les `drain*`, `draftIntents`, `portalVotes`, `resyncState`,
  `snapshot`, `useAbility`, `debugOweLevels`, `leave`, `setAbsent`, `setVote`, `portalOpen`, `tick`,
  `horde`) ; `GameClient` (`connect`, `update`, `hordeTick`, `isFrozen`).
- Produit : `GameClient#hordeAt(tick: number, into: Horde): boolean` ; dans le banc, les titres
  `LATENCE` et `PORTAIL` et les corps `latence(latency)` et `portail(latency)`, pour que les
  tâches 2 à 4 basculent une latence à la fois (`it.each([0])(LATENCE, latence)` à côté de
  `it.fails.each([1, 2, 3])(LATENCE, latence)`). Les douze scénarios sont en `it.fails` à la fin
  de la tâche.

Le front n'a rien à configurer : `front/vitest.config.ts` résout `@shared` et `@`, `back/src/room.ts`
et ses imports relatifs (`combat`, `draft`, `evenement`, `portal`, `wave-director`) n'importent que
`@shared/*` — ni base, ni `node:*` — et `npx tsc --noEmit` du front les accepte (vérifié).

- [ ] **Étape 1 : la lecture de l'anneau**

`front/src/net/client.ts`, juste après le getter `lateFreezes` (l.1973-1975), ajouter :

```ts

  /**
   * Etape 17b : copie dans `into` l'etat de la horde que l'anneau du rejeu
   * tient pour `tick`. Lecture de test (le banc salon ↔ client), comme
   * `lateDeaths` : rend `false` si l'anneau ne tient pas ce tick.
   */
  hordeAt(tick: number, into: Horde): boolean {
    return this.#hordeHistory.restore(tick, into);
  }
```

(`Horde` est déjà importé par `client.ts`.)

- [ ] **Étape 2 : écrire le banc**

Créer `front/src/net/room-client.replication.test.ts` avec ce contenu (scénarios de la spec §3 :
latences 0 à 3, hoquet sur les ticks qui émettent des petits, gel d'étalage en cinq variantes —
les trois de la spec, plus `absence` et `resync` pour l'étape 18 (écart n° 11) —, portail
« rester » à latences 0 et 2) :

```ts
// Etape 17b : le banc salon ↔ client. Un VRAI `Room` branche sur un VRAI
// `GameClient` par une fausse socket qui reproduit l'ordre des messages de
// `Session#broadcast` (back/src/server.ts), avec une latence de N ticks.
//
// ⚠️ **Le seul test du front qui importe `back/src/room`** (decision de Leo,
// spec 17b §3) : `Room` est sans E/S ni base (`back/src/room.ts`), et c'est le
// seul moyen de comparer le client a l'ordre REEL de `Room#step` plutot qu'a
// une reference qui recopierait celui du client.
import { archetypeIdOf, NECRO_CHILD, SPLIT_CHILD } from '@shared/archetypes';
import { FLOWFIELD_HZ, MAX_ENTITIES, MAX_PER_WAVE, TICK_HZ } from '@shared/constants';
import { Horde } from '@shared/horde';
import {
  decode,
  encodeAbilityUsed,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeEvent,
  encodeLevelUp,
  encodePickups,
  encodePortalOpen,
  encodePortalResult,
  encodePresence,
  encodeReaction,
  encodeResync,
  encodeRunOver,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
  VOTE_CHOICE,
} from '@shared/protocol';
import type { WaveOrder } from '@shared/waves';
import { beforeEach, expect, it, vi } from 'vitest';

import { Room } from '../../../back/src/room';
import { GameClient } from './client';

type FakeEvent = { data?: ArrayBuffer; code?: number };

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly #listeners = new Map<string, ((e: FakeEvent) => void)[]>();
  binaryType = '';
  readyState = 0;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  addEventListener(type: string, cb: (e: FakeEvent) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), cb]);
  }
  send(): void {
    // Le banc n'ecoute pas les entrees du client : le salon recoit les siennes.
  }
  close(): void {
    // Rien a fermer.
  }
  emit(type: string, e: FakeEvent): void {
    if (type === 'open') {
      this.readyState = FakeSocket.OPEN;
    }
    for (const cb of this.#listeners.get(type) ?? []) {
      cb(e);
    }
  }
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
});

const STEP = 1 / TICK_HZ;
const STEPS_PER_FIELD = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
const CHILD_ARCHETYPES = new Set([archetypeIdOf(SPLIT_CHILD), archetypeIdOf(NECRO_CHILD)]);

/**
 * Les messages d'un tick, dans l'ordre EXACT de `Session#broadcast`
 * (back/src/server.ts) : a recopier si `#broadcast` change. `resync` : la
 * socket du client attend son `RESYNC` (etape 18 : apres tous les drains,
 * avant le snapshot du meme tick).
 */
function drainLikeServer(room: Room, orders: WaveOrder[], resync: boolean): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const o of room.drainWaveOrders()) {
    orders.push(o);
    out.push(encodeWaveOrder(o));
  }
  for (const b of room.drainDeaths()) {
    out.push(encodeDeaths(b.tick, b.ids));
  }
  for (const u of room.drainAbilities()) {
    out.push(encodeAbilityUsed(u.tick, u.playerId, u.verb, u.x, u.y, u.targetId));
  }
  for (const z of room.drainZones()) {
    out.push(encodeZone(z.kind, z.x, z.y, z.bornTick, z.by));
  }
  for (const c of room.drainBossCharges()) {
    out.push(encodeBossCharge(c));
  }
  for (const r of room.drainReactions()) {
    out.push(encodeReaction(r.pair, r.x, r.y, r.tick, r.synergyCharge));
  }
  for (const b of room.drainPickups()) {
    out.push(encodePickups(b.tick, b.ids));
  }
  for (const ev of room.drainEvents()) {
    out.push(encodeEvent(ev));
  }
  for (const l of room.drainLevelUps()) {
    out.push(encodeLevelUp(l.tick, l.level));
  }
  for (const o of room.drainDraftOpens()) {
    out.push(encodeDraftOpen(o.deadlineTick, o.cards));
  }
  const intents = room.draftIntents();
  if (intents.size > 0) {
    out.push(
      encodeDraftIntents([...intents].map(([playerId, cardIndex]) => ({ playerId, cardIndex }))),
    );
  }
  for (const r of room.drainDraftResults()) {
    out.push(encodeDraftResult(r.deadlineTick, r.outcomes));
  }
  for (const o of room.drainPortalOpens()) {
    out.push(encodePortalOpen(o.deadlineTick, o.multiplier));
  }
  const votes = room.portalVotes();
  if (votes.size > 0) {
    out.push(encodeVotes([...votes].map(([playerId, choice]) => ({ playerId, choice }))));
  }
  for (const r of room.drainPortalResults()) {
    out.push(encodePortalResult(r.effectTick, r.decision, r.gold));
  }
  const fin = room.drainRunOver();
  if (fin) {
    out.push(encodeRunOver(fin.tick, fin.survivedTicks, fin.level, fin.kills));
  }
  if (resync) {
    out.push(encodeResync(room.resyncState()));
  }
  room.snapshot({ push: (m) => out.push(m) });
  return out;
}

interface Etat {
  ids: number[];
  x: number[];
  y: number[];
}

function etatDe(horde: Horde): Etat {
  const etat: Etat = { ids: [], x: [], y: [] };
  for (let i = 0; i < horde.count; i++) {
    etat.ids.push(horde.entityIdAt(i));
    etat.x.push(horde.x[i] ?? 0);
    etat.y.push(horde.y[i] ?? 0);
  }
  return etat;
}

interface Banc {
  /** Ecart regle maximal, par identite, en pixels. */
  drift: number;
  /** Identites absentes du client ou en trop, cumulees sur toute la partie. */
  lost: Set<number>;
  orders: WaveOrder[];
  deaths: number;
  stalls: number;
  frozenSeen: boolean;
  portalStay: boolean;
}

interface Options {
  mapSeed: number;
  players: number[];
  ticks: number;
  latency: number;
  aim: boolean;
  level?: number;
  classes?: Record<number, number>;
  /**
   * Avant chaque `room.step` (tick a venir : `room.tick + 1`). `send` : un
   * message envoye HORS diffusion (`PRESENCE`, etape 18), qui part avant
   * celle du tick a venir.
   */
  before?: (
    room: Room,
    nextTick: number,
    players: number[],
    send: (m: ArrayBuffer) => void,
  ) => void;
  /**
   * Etape 18 : la page du client se recharge et rejoint juste avant ce tick —
   * un client NEUF, `WELCOME` puis le `RESYNC` de la diffusion de ce tick.
   * Latence 0 seulement.
   */
  resyncAt?: number;
  /** Vrai : la diffusion de ce tick part avec celle du suivant (hoquet d'une image). */
  stall?: (tick: number, msgs: ArrayBuffer[]) => boolean;
}

/**
 * Fait tourner le salon et le client ensemble, une image par tick. L'ecart se
 * mesure « regle » : au tick `room.tick − latency`, tout ce que le salon a
 * diffuse pour ce tick est arrive, et l'anneau du client (`hordeAt`) doit
 * egaler l'etat que le salon avait a la fin de ce tick, entite par entite.
 *
 * Une entite que le salon porte deja mais dont l'ordre est date du tick
 * SUIVANT (les petits, `spawnTick = T + 1`, inseres a la fin de `T`) n'est
 * pas encore nee pour le client : elle ne compte pas comme manquante.
 */
function banc(opts: Options): Banc {
  const players = [...opts.players];
  const room = new Room(opts.mapSeed);
  for (const id of players) {
    room.join(id, undefined, undefined, opts.classes?.[id]);
  }
  if (opts.level) {
    room.debugSetLevel(opts.level);
  }
  const brancher = (welcomeTick: number): { client: GameClient; socket: FakeSocket } => {
    const c = new GameClient('ws://banc', () => ({ x: 0, y: 0 }), vi.fn());
    c.connect();
    const s = FakeSocket.instances[FakeSocket.instances.length - 1] as FakeSocket;
    s.emit('open', {});
    s.emit('message', { data: encodeWelcome(players[0] ?? 1, welcomeTick, room.mapSeed) });
    return { client: c, socket: s };
  };
  // Le client simule le tick 1 juste apres le salon : a latence nulle, chaque
  // message arrive avant que le client simule son tick.
  let { client, socket } = brancher(1);

  const out: Banc = {
    drift: 0,
    lost: new Set(),
    orders: [],
    deaths: 0,
    stalls: 0,
    frozenSeen: false,
    portalStay: false,
  };
  const spawnTickOf = new Map<number, number>();
  const queue: { at: number; data: ArrayBuffer }[] = [];
  const past = new Map<number, Etat>();
  const scratch = new Horde(MAX_ENTITIES);
  let seq = 1;
  for (let f = 1; f <= opts.ticks; f++) {
    const next = room.tick + 1;
    let k = 0;
    for (const id of players.filter((i) => room.positionOf(i))) {
      const a = next * 0.01 + k++ * 2;
      const mx = Math.round(Math.cos(a) * 127);
      const my = Math.round(Math.sin(a) * 127);
      room.applyInput(id, seq, mx, my, opts.aim ? mx : 0, opts.aim ? my : 0);
      // Personne ne meurt : le banc mesure la horde, pas la survie.
      room.debugSetHp(id, room.maxHpOf(id));
    }
    seq++;
    if (next === opts.resyncAt) {
      ({ client, socket } = brancher(room.tick));
    }
    const horsDiffusion: ArrayBuffer[] = [];
    opts.before?.(room, next, players, (m) => horsDiffusion.push(m));
    room.step(STEP);
    const resync = room.tick === opts.resyncAt;
    const msgs = [...horsDiffusion, ...drainLikeServer(room, out.orders, resync)];
    for (const o of out.orders) {
      spawnTickOf.set(o.waveId, o.spawnTick);
    }
    for (const m of msgs) {
      const d = decode(m);
      if (d.type === MSG.DEATHS) {
        out.deaths += d.ids.length;
      }
      if (d.type === MSG.PORTAL_RESULT && d.decision === VOTE_CHOICE.STAY) {
        out.portalStay = true;
      }
    }
    const stall = opts.stall?.(room.tick, msgs) ?? false;
    if (stall) {
      out.stalls++;
    }
    for (const data of msgs) {
      queue.push({ at: room.tick + opts.latency + (stall ? 1 : 0), data });
    }
    // Tri stable : a date egale, l'ordre d'emission.
    queue.sort((a, b) => a.at - b.at);
    while ((queue[0]?.at ?? Number.POSITIVE_INFINITY) <= room.tick) {
      socket.emit('message', { data: queue.shift()?.data });
    }
    // Le `RESYNC` de `T` pose la horde de `T` : pas de pas client cette image.
    if (!resync) {
      client.update(room.tick * STEP * 1000, STEP);
    }
    expect(client.hordeTick - 1).toBe(room.tick);
    out.frozenSeen ||= client.isFrozen;

    past.set(room.tick, etatDe(room.horde));
    past.delete(room.tick - 12);
    const t = room.tick - opts.latency - (stall ? 1 : 0);
    const ref = past.get(t);
    if (!ref || !client.hordeAt(t, scratch)) {
      continue;
    }
    const slots = new Map<number, number>();
    for (let i = 0; i < scratch.count; i++) {
      slots.set(scratch.entityIdAt(i), i);
    }
    const attendus = new Set<number>();
    ref.ids.forEach((id, i) => {
      if ((spawnTickOf.get(Math.floor(id / MAX_PER_WAVE)) ?? 0) > t) {
        return;
      }
      attendus.add(id);
      const j = slots.get(id);
      if (j === undefined) {
        out.lost.add(id);
        return;
      }
      const d = Math.hypot(
        (ref.x[i] ?? 0) - (scratch.x[j] ?? 0),
        (ref.y[i] ?? 0) - (scratch.y[j] ?? 0),
      );
      out.drift = Math.max(out.drift, d);
    });
    // En trop : ni attendue, ni pas encore nee au salon.
    const auSalon = new Set(ref.ids);
    for (const id of slots.keys()) {
      if (!attendus.has(id) && !auSalon.has(id)) {
        out.lost.add(id);
      }
    }
  }
  return out;
}

function rapport(nom: string, r: Banc): void {
  process.stdout.write(
    `[etape 17b] ${nom} : ecart regle ${r.drift.toFixed(3)} px, ${r.lost.size} perdues, ` +
      `${r.orders.length} ordres, ${r.deaths} morts, ${r.stalls} hoquets\n`,
  );
}

const LATENCE =
  'latence %i : 1 200 ticks de vagues, de morts, de diviseurs et de necromanciens — 0,000 px, 0 perte';

function latence(latency: number): void {
  const r = banc({
    mapSeed: 0xd1a6_0005,
    players: [1, 2],
    ticks: 1200,
    latency,
    aim: true,
    level: 6,
  });
  rapport(`latence ${latency}`, r);
  // Ce que le scenario doit contenir, sans quoi « 0,000 px » ne dirait rien.
  const directeur = r.orders.filter((o) => !CHILD_ARCHETYPES.has(o.archetype));
  expect(directeur.filter((o) => o.spawnTick % STEPS_PER_FIELD === 0).length).toBeGreaterThan(3);
  expect(r.orders.some((o) => o.archetype === archetypeIdOf(SPLIT_CHILD))).toBe(true);
  expect(r.orders.some((o) => o.archetype === archetypeIdOf(NECRO_CHILD))).toBe(true);
  expect(r.deaths).toBeGreaterThan(0);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
}

it.fails.each([0, 1, 2, 3])(LATENCE, latence);

it.fails('hoquet d une image sur les ticks qui emettent des petits — 0,000 px, 0 perte', () => {
  const r = banc({
    mapSeed: 0xd1a6_0002,
    players: [1, 2],
    ticks: 1500,
    latency: 0,
    aim: true,
    level: 6,
    // Un tick qui emet un petit (`spawnTick = T + 1`) sans vague du directeur :
    // snapshot, morts et ordre partent une image en retard.
    stall: (tick, msgs) => {
      const ordres = msgs.map((m) => decode(m)).filter((m) => m.type === MSG.WAVE_ORDER);
      return (
        ordres.some((o) => CHILD_ARCHETYPES.has(o.archetype) && o.spawnTick === tick + 1) &&
        !ordres.some((o) => o.spawnTick === tick)
      );
    },
  });
  rapport('hoquet', r);
  expect(r.stalls).toBeGreaterThan(0);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
});

it.fails.each([
  'depart',
  'arrivee',
  'leurre',
  'absence',
  'resync',
] as const)('gel d etalage avec un(e) %s — 0,000 px, 0 perte', (mode) => {
  let leurre = false;
  const r = banc({
    mapSeed: 0xd1a6_0007,
    players: [1, 2],
    ticks: 1400,
    latency: 0,
    aim: false,
    // La classe 2 (Appat) pose un leurre.
    classes: { 1: 2 },
    // Etape 18 : `absence`, le joueur 2 tombe pendant le gel et reste en grace
    // (`PRESENCE` hors diffusion) ; `resync`, idem, puis la page du client se
    // recharge pendant le gel et repart de l'etat complet (absents et
    // historique compris).
    resyncAt: mode === 'resync' ? 450 : undefined,
    before: (room, next, players, send) => {
      if (next === 400 && mode === 'leurre') {
        const p = room.positionOf(1);
        leurre = !!p && room.useAbility(1, p.x + 300, p.y) !== null;
      }
      if (next === 401) {
        room.debugOweLevels(1);
      }
      if (next === 450 && mode === 'depart') {
        room.leave(2);
      }
      if (next === 450 && mode === 'arrivee') {
        room.join(3);
        players.push(3);
      }
      if ((next === 450 && mode === 'absence') || (next === 430 && mode === 'resync')) {
        room.setAbsent(2, true);
        send(encodePresence(2, false));
      }
    },
  });
  rapport(`gel d etalage, ${mode}`, r);
  expect(r.frozenSeen).toBe(true);
  if (mode === 'leurre') {
    expect(leurre).toBe(true);
  }
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
});

const PORTAIL = 'portail traverse, « rester », latence %i — 0,000 px, 0 perte';

function portail(latency: number): void {
  const r = banc({
    mapSeed: 4242,
    players: [1, 2],
    ticks: 4200,
    latency,
    // Sans tir : ni niveau ni etalage, le portail tombe a la vingtieme vague.
    aim: false,
    before: (room) => {
      if (room.portalOpen) {
        room.setVote(1, VOTE_CHOICE.STAY);
        room.setVote(2, VOTE_CHOICE.STAY);
      }
    },
  });
  rapport(`portail, latence ${latency}`, r);
  expect(r.portalStay).toBe(true);
  expect(r.drift).toBeLessThan(0.0005);
  expect(r.lost.size).toBe(0);
}

it.fails.each([0, 2])(PORTAIL, portail);
```

Ce que mesure le banc, et pourquoi : l'**écart réglé** compare, au tick `room.tick − latency`
(un de moins sur une image de hoquet), l'état de fin de pas du salon et l'anneau du client, **par
identité** (`entityIdAt`, jamais par créneau : les deux côtés compactent différemment) ; une
identité absente ou en trop entre dans `lost`, à jamais. L'ordre des messages recopie
`Session#broadcast` (`back/src/server.ts` l.639-767 à `44e4e9b`), `RESYNC` compris (après tous
les drains, avant le snapshot), latence comprise : une file datée, triée de façon stable ; un
`PRESENCE` part hors diffusion (`Session#remove`, l.362 ; le retour, l.256), donc avant la
diffusion du tick suivant. Le rechargement (`resync`) branche un client NEUF juste avant le tick
choisi, `WELCOME` au tick du salon, et ne le fait pas avancer dans l'image du `RESYNC` (qui pose
déjà la horde de ce tick) : latence 0 seulement. Les PV des joueurs sont remis au maximum à chaque pas : le banc
mesure la horde, pas la survie. Écarts n° 5 et 6 pour les petits pas encore nés et la graine.

- [ ] **Étape 3 : le lancer — tout est rouge, la porte reste verte**

Run : `cd front && npx vitest run src/net/room-client.replication.test.ts`
Attendu : `Tests  12 expected fail (12)` (une vingtaine de secondes), et une ligne
`[etape 17b] …` par scénario. Mesuré à `252ab47` puis à `44e4e9b` (mêmes écarts ; à `44e4e9b`,
18 ordres et 137 morts par scénario de latence) :

| Scénario | Écart réglé | Perdues |
| --- | --- | --- |
| latence 0 | 992,653 px | 0 |
| latence 1 | 230,465 px | 460 |
| latence 2 | 449,539 px | 460 |
| latence 3 | 425,034 px | 460 |
| hoquet | 3 483,485 px | 5 |
| gel d'étalage, départ / arrivée / leurre / absence / resync | 139,536 px | 0 |
| portail, latence 0 | 5 566,747 px | 0 |
| portail, latence 2 | 5 566,554 px | 1 829 |

Si un scénario **passe** (« Expect test to fail »), s'arrêter : le banc ne voit plus ce que la
spec dit qu'il voit. Le dire au contrôleur, ne rien basculer.

- [ ] **Étape 4 : vérifier que le banc rougit pour la bonne raison**

Dans une copie jetable où `it.fails` devient `it` :

```bash
cd front && sed 's/^it\.fails/it/' src/net/room-client.replication.test.ts > src/net/banc-temoin.test.ts \
  && npx vitest run src/net/banc-temoin.test.ts 2>&1 | grep -E "AssertionError|Tests " ; rm src/net/banc-temoin.test.ts
```

Attendu : `Tests  12 failed (12)`, et des `AssertionError` sur `drift` ou `lost.size` — jamais sur
les gardes de contenu (diviseurs, nécromanciens, vagues sur rafraîchissement, morts, hoquets,
gel vu, leurre posé, « rester »). Puis `git status` : la copie a disparu.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/net/room-client.replication.test.ts front/src/net/client.ts
git add front/src/net/room-client.replication.test.ts front/src/net/client.ts
git commit -m "test(front): le banc salon client, rouge sur chacun de ses douze scenarios"
```

---

### Tâche 2 : serveur — naître avant de rafraîchir, et l'historique pendant le gel

**Fichiers :**
- Modifier : `back/src/room.ts` (docbloc de `step` l.1415-1451 ; les trois retours gelés
  l.1468-1497 ; bloc de rafraîchissement l.1570-1587 ; fin des naissances l.1650-1656 ; fin de
  `step` l.1979-2003)
- Tester : `back/src/room.test.ts` (un `describe` ajouté à la fin du fichier, après la `});`
  finale l.7104) ; `front/src/net/room-client.replication.test.ts` (bascules)

**Interfaces :**
- Consomme : le banc de la tâche 1.
- Produit : dans `Room#step`, l'ordre devient naissances du directeur → `#startEvent` →
  rafraîchissement des champs et `retarget` (tous les `STEPS_PER_FIELD` pas) → `horde.step`.
  `#recordHistory(): void` (privé) enregistre les positions arrondies des vivants au tick courant ;
  appelé en fin de pas **et** avant les trois `return` gelés (portail, étalage, gel), jamais après
  `#runOver`. `room.fieldInputTick` (getter existant, l.914-916) reste la lecture de test ;
  `room.resyncState().history` (étape 18) le témoin du §7 de la spec.

- [ ] **Étape 1 : écrire les tests du salon**

À la fin de `back/src/room.test.ts` (après la dernière `});`, l.7104), ajouter :

```ts
describe('etape 17b : la synchro exacte, cote salon', () => {
  it('une vague nait AVANT le rafraichissement du champ de son tick, et le reciblage la voit', () => {
    const room = new Room(4242);
    room.join(1);
    room.join(2);
    const spawn = vi.spyOn(room.horde, 'spawn');
    const retarget = vi.spyOn(room.horde, 'retarget');
    let vu = false;
    for (let t = 0; t < 30 * TICK_HZ && !vu; t++) {
      spawn.mockClear();
      retarget.mockClear();
      room.step(DT);
      if (room.drainWaveOrders().length > 0 && retarget.mock.calls.length > 0) {
        vu = true;
        // Toutes les naissances du pas precedent le reciblage du pas.
        const derniereNaissance = Math.max(...spawn.mock.invocationCallOrder);
        expect(derniereNaissance).toBeLessThan(retarget.mock.invocationCallOrder[0] ?? 0);
      }
    }
    // `PERIOD_TICKS` est un multiple de la cadence du champ : chaque vague du
    // directeur tombe sur un rafraichissement. Sans ce garde, le test ne dirait rien.
    expect(vu).toBe(true);
  }, 60_000);

  it('au premier rafraichissement apres un degel, le champ lit tick − FIELD_INPUT_DELAY_TICKS', () => {
    const room = new Room(4242);
    room.join(1);
    for (let t = 0; t < TICK_HZ; t++) {
      room.step(DT);
    }
    room.debugOweLevels(1);
    room.step(DT);
    expect(room.drainDraftOpens()).toHaveLength(1);
    // Une seconde de gel : bien plus que le retard de lecture du champ.
    for (let t = 0; t < TICK_HZ; t++) {
      room.step(DT);
    }
    // Spec 17b §7 : le `RESYNC` d'un revenant pendant le gel porte les lignes
    // des ticks geles, la derniere celle du tick courant (etape 18).
    expect(room.resyncState().history.map((h) => h.ids)).toEqual(
      Array.from({ length: RESYNC_HISTORY_TICKS }, () => [1]),
    );
    room.setDraftToken(1, 0);
    // Le monde gele ne rafraichit rien : le premier rafraichissement qui
    // bouge `fieldInputTick` est celui d'apres le degel.
    const gele = room.fieldInputTick;
    for (let t = 0; t < 60 * TICK_HZ && room.fieldInputTick === gele; t++) {
      room.step(DT);
    }
    expect(room.fieldInputTick).not.toBe(gele);
    // Sans l'historique pendant le gel, `delayed()` retomberait sur la
    // derniere ligne d'avant le gel.
    expect(room.tick - room.fieldInputTick).toBe(FIELD_INPUT_DELAY_TICKS);
  }, 60_000);
});
```

(`vi`, `TICK_HZ`, `DT`, `FIELD_INPUT_DELAY_TICKS`, `RESYNC_HISTORY_TICKS` et `Room` sont déjà
importés ou définis en tête du fichier, l.1-108.)

- [ ] **Étape 2 : les voir échouer**

Run : `cd back && npx vitest run src/room.test.ts -t "etape 17b"`
Attendu : 2 échecs — `expected 61 to be less than 59` (le dernier `spawn` vient après le
`retarget` du pas) et `expected [ [], [], [], [], [], [] ] to deeply equal [ [ 1 ], [ 1 ], …` (le
salon gelé n'enregistre rien : le `RESYNC` d'un revenant porterait six lignes vides ; sans cette
assertion, la suivante échoue en `expected 33 to be 3` — après une seconde de gel, `delayed()`
retombe sur la dernière ligne d'avant le gel). Mesuré à `44e4e9b`.

- [ ] **Étape 3 : le rafraîchissement après les naissances**

`back/src/room.ts`, **couper** le bloc l.1570-1588 (de `const stepsPerField = Math.max(1, …` à
la `}` qui ferme `if (this.#tick % stepsPerField === 0)`, ligne vide suivante comprise), et le
**recoller** juste après la fermeture du `if (graineEvenement !== null) { … }` (l.1656), donc
juste avant le commentaire `// ⚠️ **Le portail s'ouvre toutes les \`PORTAL_EVERY_WAVES\` vagues**`,
précédé de deux lignes :

```ts
    // Etape 17b : APRES les naissances du pas (directeur, proies), comme le
    // client — un nouveau-ne est recible a son tick de naissance.
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    if (this.#tick % stepsPerField === 0) {
      // ⚠️ Les positions **retardees**, pas les courantes. Le serveur s'impose
      // le retard qu'il inflige au client : c'est ce qui rend les deux champs
      // identiques.
      const seen = this.#history.delayed(this.#tick);
      if (seen) {
        this.#fieldInputTick = seen.tick;
        // ⚠️ Les leurres remplacent leur lanceur, au tick des POSITIONS
        // (`seen.tick`), jamais au tick courant : c'est lui que le client
        // partage. Meme fonction que les sites du miroir client.
        const cible = substituteDecoys(seen.ids, seen.x, seen.y, this.#decoys, seen.tick);
        for (let f = 0; f < cible.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(cible.x[f] ?? 0, cible.y[f] ?? 0);
        }
        this.horde.retarget(cible.x, cible.y);
      }
    }

```

Le bloc ne change pas ; seule sa place change. L'ouverture du portail, qui suit, ne touche pas la
horde : peu importe qu'elle vienne après.

- [ ] **Étape 4 : `#recordHistory()` et les trois retours gelés**

Fin de `step` (l.1989-2003) : remplacer

```ts
    const ids: number[] = [];
    const rxs: number[] = [];
    const rys: number[] = [];
```

(l'unique occurrence, juste après le commentaire `// Arrondies, comme sur le fil : …`, l.1979)
par

```ts
    this.#recordHistory();
  }

  /**
   * Enregistre les positions des vivants de ce tick, arrondies comme sur le
   * fil. Etape 17b : appele aussi par les trois retours geles de `step`
   * (portail, etalage, gel) — le client enregistre chaque snapshot gele, et
   * apres le degel `delayed()` doit lire la meme ligne des deux cotes (un
   * depart, une arrivee ou un leurre pendant le gel). Jamais apres
   * `#runOver` : plus rien n'y lit le champ.
   */
  #recordHistory(): void {
    const ids: number[] = [];
    const rxs: number[] = [];
    const rys: number[] = [];
```

Le reste du bloc (la boucle sur les vivants — **avec son filtre tel qu'il est**,
`p.hp > 0 && !p.absent` depuis l'étape 18 — puis `this.#history.record(…)` et la `}` de `step`)
devient le corps de `#recordHistory` sans autre changement. Le commentaire
`// Arrondies, comme sur le fil : …` (l.1979-1988) reste au-dessus de l'appel.

Puis, avant chacun des trois `return` gelés, ajouter `this.#recordHistory();` :

```ts
    if (this.portalOpen) {
      this.#stepPortal();
      this.#recordHistory();
      return;
    }
```

```ts
    if (this.#draft.phase !== 'closed') {
      this.#stepDraft();
      this.#recordHistory();
      return;
    }
```

```ts
      // les ramassages continueraient pendant le gel.
      this.#recordHistory();
      return;
    }
```

Pas dans le retour de `#runOver` (l.1455-1459).

- [ ] **Étape 5 : le docbloc de `step`**

Dans le bloc de séquence (l.1421-1442), remplacer

```ts
   * 4. rafraichir les champs si du (tick % stepsPerField)
   * 5. appliquer les ordres de vague en attente
```

par

```ts
   * 4. faire naitre les vagues du directeur, puis les proies d'un evenement
   * 5. rafraichir les champs si du (tick % stepsPerField), et recibler toute
   *    la horde — nouveau-nes compris
```

et

```ts
   * 11. enregistrer l'historique de positions des vivants, en FIN de pas
   * ```
```

par

```ts
   * 11. enregistrer l'historique de positions des vivants, en FIN de pas
   *     (`#recordHistory`) — aussi a chaque tick gele (portail, etalage, gel)
   * ```
```

Puis remplacer l'avertissement l.1448-1450 (il cite un scénario 9 qui ne vérifie pas cet ordre :
il fait naître une fois, avant sa boucle — spec §1.1)

```ts
   * ⚠️ **Etapes 4 et 5 : le rafraichissement precede l'engendrement.**
   * `shared/horde.replication.test.ts` verifie cet ordre a 0 px de derive avec
   * rejeu (scenario 9). Ne pas inverser sans rejouer ce scenario.
```

par

```ts
   * ⚠️ **Etapes 4 et 5 : l'engendrement precede le rafraichissement**, comme
   * au client (`GameClient#advanceHorde`, `#replayTick`) et dans tous les
   * scenarios partages : `PERIOD_TICKS` est un multiple de la cadence du
   * champ, donc CHAQUE vague du directeur tombe sur un rafraichissement, et
   * l'ordre inverse (avant l'etape 17b) decalait le client de centaines de
   * pixels. Les petits (`#spawnAt`, `spawnTick = T + 1`) sont inseres a la fin
   * de `T` : avant le rafraichissement de `T + 1`, la aussi. Verifie par le
   * banc salon ↔ client (`front/src/net/room-client.replication.test.ts`).
```

- [ ] **Étape 6 : les tests du salon passent, et ceux qui touchent l'ordre du pas aussi**

Run : `cd back && npx vitest run src/room.test.ts`
Attendu : tout vert (193 tests : 191 à `44e4e9b` + 2), dont les deux « etape 17b », l'existant
« calcule ses champs sur des positions retardees » (l.541-552) et ceux de l'instantané de
l'étape 18 (`describe` « etape 18 », l.6850-7104). Mesuré à `44e4e9b`.

Mesuré à l'écriture du plan, avec ce changement (le sous-agent ne les relance pas, le portique le
fera) : `comportements`, `carte`, `evenement`, `verbes`, `difficulte`, `depart`, `combat`,
`portal`, `draft`, `wave-director`, `loop`, `rooms` (`back/src/*.test.ts`),
`shared/horde.replication.test.ts` (440 tests verts), et `shared/horde-history.test.ts`. Seuls
`back/src/server.test.ts` et les `*.integration.test.ts` (Postgres, dont
`reconnexion.integration.test.ts` de l'étape 18) n'ont pas tourné : tâche 6. Rejoué à `44e4e9b`
avec les quatre tâches : `shared/horde.replication.test.ts` (46 tests, ~5 min) et
`shared/horde-history.test.ts` verts.

- [ ] **Étape 7 : basculer ce que le serveur répare**

`front/src/net/room-client.replication.test.ts` :
- le `it.fails.each([` des gels d'étalage (celui qui ouvre la liste `'depart'`, `'arrivee'`,
  `'leurre'`, `'absence'`, `'resync'`) devient `it.each([` ;
- `it.fails.each([0, 2])(PORTAIL, portail);` devient

```ts
it.each([0])(PORTAIL, portail);
it.fails.each([2])(PORTAIL, portail);
```

Run : `cd front && npx vitest run src/net/room-client.replication.test.ts`
Attendu : `Tests  6 passed | 6 expected fail (12)`. Mesuré (à `252ab47` puis à `44e4e9b`) : les
cinq gels et le portail à latence 0 à **0,000 px, 0 perdue** ; latence 0 encore à 54,634 px (les ordres du futur, tâche 3),
latences 1 à 3 à 988,914 / 423,200 / 423,368 px et 460 perdues, hoquet 1 405,337 px, portail à
latence 2 5 270,021 px et 1 829 perdues (tâche 4).

- [ ] **Étape 8 : commit**

```bash
npx biome check --write back/src/room.ts back/src/room.test.ts front/src/net/room-client.replication.test.ts
git add back/src/room.ts back/src/room.test.ts front/src/net/room-client.replication.test.ts
git commit -m "fix(back): naitre avant de rafraichir le champ, et l historique pendant le gel"
```

---

### Tâche 3 : client — les ordres du futur, et chaque snapshot à son arrivée

**Fichiers :**
- Modifier : `front/src/net/client.ts` (`#onFrame`, le bloc `#lastPositions` l.2865-2875 et son
  champ l.1429-1434 ; `#advanceHorde` l.3128-3142 ; `#applyPendingOrders` l.4197-4198)
- Tester : `front/src/net/client.test.ts` (un `describe` ajouté à la fin du fichier) ;
  `front/src/net/room-client.replication.test.ts` (bascule)

**Interfaces :**
- Consomme : le banc (tâche 1), le salon corrigé (tâche 2).
- Produit : un ordre de `spawnTick > tick` reste dans `#pendingOrders` ; `#history` (le
  `PlayerHistory` du client) reçoit une ligne par snapshot, sous `msg.tick`, à la réception, avec
  le filtre des vivants présents de l'étape 18 ; `#lastPositions` disparaît. La tâche 4 réécrit
  `#applyPendingOrders` en entier et garde ces deux comportements.

- [ ] **Étape 1 : écrire les tests**

À la fin de `front/src/net/client.test.ts`, ajouter :

```ts

describe('etape 17b : la synchro exacte, cote client', () => {
  const JOUEURS = [0, 1, 2, 3].map((i) => ({
    id: i,
    x: 3000 + i * 200,
    y: 3000,
    hp: 100,
    aimX: 0,
    aimY: 0,
    pickupRadius: ORB_PICKUP_RADIUS,
    shield: 0,
  }));

  function ouvrir(welcomeTick: number): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, welcomeTick, 0xd8a5_0017) });
    return { client, socket };
  }

  function vague(waveId: number, spawnTick: number, count = 10): WaveOrder {
    return {
      waveId,
      spawnTick,
      seed: 0x51ee_d000 + waveId,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count,
    };
  }

  /** Une image : le snapshot du tick que le client va simuler, puis ce pas. */
  function image(client: GameClient, socket: FakeSocket, tick: number): void {
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, JOUEURS) });
    client.update(tick * STEP, STEP);
  }

  it('un ordre du futur reste en file jusqu a son tick (horloge du client en retard apres le WELCOME)', () => {
    const { client, socket } = ouvrir(5000);
    const spy = vi.spyOn(client.horde, 'spawnCatchingUp');
    // Le salon a deja simule 5003 quand l'ordre arrive ; le client, rien.
    socket.emit('message', { data: encodeWaveOrder(vague(1, 5003)) });
    for (let t = 5000; t < 5003; t++) {
      image(client, socket, t);
      expect(client.horde.count).toBe(0);
    }
    image(client, socket, 5003);
    expect(client.horde.count).toBe(10);
    // Ne a son tick, sans pas rattrape.
    expect(spy.mock.calls.map((c) => c[1])).toEqual([0]);
  });

  it.each([
    false,
    true,
  ])('deux snapshots dans la meme image : chacun entre a l historique (gel : %s)', (gel) => {
    const { client, socket } = ouvrir(0);
    const aux = (t: number) => JOUEURS.map((p) => ({ ...p, x: 1000 + t * 10 + p.id * 500 }));
    const retarget = vi.spyOn(client.horde, 'retarget');
    let lu: number | undefined;
    for (let t = 0; t <= 9; t++) {
      // Les snapshots arrivent par deux : rien aux ticks pairs, `t − 1` et `t` aux impairs.
      if (t % 2 === 1) {
        socket.emit('message', { data: encodeSnapshot(t - 1, 0, 0, aux(t - 1)) });
        socket.emit('message', { data: encodeSnapshot(t, 0, 0, aux(t)) });
      }
      // Gel de 3 a 8 inclus : le rafraichissement de 9 lit la ligne 6, un tick gele.
      if (gel && t === 2) {
        socket.emit('message', { data: encodeLevelUp(3, 2) });
      }
      if (gel && t === 8) {
        socket.emit('message', { data: encodeDraftResult(8, []) });
      }
      retarget.mockClear();
      client.update(t * STEP, STEP);
      if (t === 9) {
        lu = retarget.mock.calls[0]?.[0][0];
      }
    }
    // Le tick pair 6 est arrive dans la meme image que 7 : sans lui, `delayed()`
    // retomberait sur la ligne 5.
    expect(lu).toBe(1000 + 6 * 10);
  });
});
```

(`GameClient`, `FakeSocket`, `latestSocket`, `encodeWelcome`, `encodeWaveOrder`, `encodeSnapshot`,
`encodeLevelUp`, `encodeDraftResult`, `FORMATION`, `WaveOrder`, `ORB_PICKUP_RADIUS`, `STEP` sont
déjà importés ou définis dans le fichier, l.1-551.)

- [ ] **Étape 2 : les voir échouer**

Run : `cd front && npx vitest run src/net/client.test.ts -t "etape 17b"`
Attendu : 3 échecs — l'ordre du futur naît dès la première image (`expected 10 to be +0`), et
les deux « deux snapshots » lisent la ligne 5 (`expected 1050 to be 1060`). Mesuré à `44e4e9b`
(l'étape 18 filtre à la réception mais n'enregistre toujours que le dernier snapshot).

- [ ] **Étape 3 : les ordres du futur attendent leur tick**

`front/src/net/client.ts`, dans `#applyPendingOrders` (l.4197-4198), remplacer

```ts
    // Tri stable : a tick egal, l'ordre d'arrivee, celui du salon.
    const orders = this.#pendingOrders.splice(0).sort((a, b) => a.spawnTick - b.spawnTick);
```

par

```ts
    // Etape 17b : un ordre du FUTUR (un petit ne a `T + 1`, ou une horloge en
    // retard sur le salon) reste en file jusqu'a son tick.
    const all = this.#pendingOrders.splice(0);
    this.#pendingOrders.push(...all.filter((o) => o.spawnTick > tick));
    // Tri stable : a tick egal, l'ordre d'arrivee, celui du salon.
    const orders = all.filter((o) => o.spawnTick <= tick).sort((a, b) => a.spawnTick - b.spawnTick);
```

(La tâche 4 réécrit cette fonction ; ce comportement y est gardé.)

- [ ] **Étape 4 : chaque snapshot entre à l'historique à son arrivée**

L'étape 18 filtre déjà les vivants présents **à la réception**, mais les range dans
`#lastPositions` que `#advanceHorde` enregistre au pas suivant — le seul dernier snapshot de
l'image. Dans `#onFrame` (l.2865-2875), remplacer

```ts
    // Les vivants PRESENTS, comme `Room.step` (un mort n'est pas une cible, un
    // absent non plus) : filtres ICI, au tick du snapshot, pas au prochain pas.
    const presents = msg.players.filter((p) => p.hp > 0 && !this.#absent.has(p.id));
    this.#lastPositions = {
      tick: msg.tick,
      x: presents.map((p) => p.x),
      y: presents.map((p) => p.y),
      // Le meme ordre que le serveur, et les identifiants avec : un leurre
      // retrouve son lanceur par son id (`shared/decoys.ts`).
      ids: presents.map((p) => p.id),
    };
```

par

```ts
    // Etape 17b : CHAQUE snapshot entre a l'historique, a son arrivee, sous le
    // tick SERVEUR de ses positions — jamais le seul dernier de l'image : deux
    // snapshots recus ensemble laisseraient un trou que `delayed()` comblerait
    // par une autre ligne qu'au salon. Non gate par le gel : le salon
    // enregistre aussi chaque tick gele (`Room#recordHistory`).
    //
    // Les vivants PRESENTS, comme `Room#recordHistory` (un mort n'est pas une
    // cible, un absent non plus — etape 18), filtres a la reception : un
    // `PRESENCE` recu apres ce snapshot ne retouche pas un tick que le salon a
    // enregistre sans lui. Le meme ordre que le serveur, et les identifiants
    // avec : un leurre retrouve son lanceur par son id (`shared/decoys.ts`).
    const presents = msg.players.filter((p) => p.hp > 0 && !this.#absent.has(p.id));
    this.#history.record(
      msg.tick,
      presents.map((p) => p.x),
      presents.map((p) => p.y),
      presents.map((p) => p.id),
    );
```

Supprimer le champ `#lastPositions` et son docbloc (l.1429-1434, de
`/**\n   * L'entree d'historique du dernier snapshot, filtree A LA RECEPTION` à
`#lastPositions: { … } | null = null;`).

Puis dans `#advanceHorde`, remplacer tout le bloc l.3128-3142, du commentaire
`// Les positions telles que le client les connait : …` à la `}` du `if (positions) { … }`, par :

```ts
    // L'historique des joueurs s'enregistre a la reception (`#onFrame`).
    const snapshot = this.#buffer.latest();
```

(`snapshot` sert encore plus bas : `#anchorPlayers`, `#fireWeapons`.)

- [ ] **Étape 5 : les tests passent**

Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : tout vert, les trois « etape 17b » compris (161 tests à `44e4e9b`), dont ceux de
l'étape 18 sur le `RESYNC` et la `PRESENCE` (« un absent du snapshot n alimente pas l historique du
champ »).

- [ ] **Étape 6 : basculer la latence 0**

`front/src/net/room-client.replication.test.ts` : `it.fails.each([0, 1, 2, 3])(LATENCE, latence);`
devient

```ts
it.each([0])(LATENCE, latence);
it.fails.each([1, 2, 3])(LATENCE, latence);
```

Run : `cd front && npx vitest run src/net/room-client.replication.test.ts`
Attendu : `Tests  7 passed | 5 expected fail (12)` ; la ligne `[etape 17b] latence 0 : ecart regle
0.000 px, 0 perdues, 17 ordres, 128 morts, 0 hoquets`. Le hoquet reste rouge (1 339,426 px) :
il attend aussi le journal (tâche 4). Mesuré à `44e4e9b`.

- [ ] **Étape 7 : commit**

```bash
npx biome check --write front/src/net/client.ts front/src/net/client.test.ts front/src/net/room-client.replication.test.ts
git add front/src/net/client.ts front/src/net/client.test.ts front/src/net/room-client.replication.test.ts
git commit -m "fix(front): les ordres du futur attendent leur tick, chaque snapshot entre a l historique"
```

---

### Tâche 4 : client — le journal des ordres et un seul rejeu par pas

**Fichiers :**
- Modifier : `shared/horde-history.ts` (`restore` l.69-80, deux méthodes après lui) ;
  `front/src/net/client.ts` (voir les étapes 4 à 10 : constante après `FIXED_DT` l.233, champs
  l.1553 et l.1630-1635, getter après `lateFreezes`, `#advanceHorde` l.3122-3125 et l.3283-3294,
  le bloc des drains et des morts l.3842-4031, `#applyDecoy` l.4116-4148, `#replayTick` à
  `#freezeTouches` l.4150-4251, `#replayFrom` l.4285-4306, `#onResync` l.2966-2968, l.3005-3006
  et l.3065-3066, deux commentaires l.379 et l.2668 — ancres de `44e4e9b`, décalées de quelques
  lignes par les tâches 1 et 3 : se fier aux textes cités) ; commentaires dans
  `back/src/combat.ts`, `back/src/room.ts`, `back/src/room.test.ts`,
  `shared/horde.replication.test.ts`
- Tester : `front/src/net/client.test.ts` (un `describe` ajouté à la fin ; deux tests existants
  modifiés, l.195-247 et l.5616-5659 ; la référence du `RESYNC` de l'étape 18, l.5692-5712 et
  l.5793-5794) ; `front/src/net/room-client.replication.test.ts` (bascules)

**Interfaces :**
- Consomme : la file des ordres et l'historique à la réception (tâche 3), `hordeAt` (tâche 1).
- Produit :
  - `HordeHistory#holds(tick: number): boolean` et `HordeHistory#clear(): void` ;
  - `GameClient#lateOrders: number` (getter) ;
  - privés : `#spawned: WaveOrderMessage[]`, `#journal(order, tick)`, `#replayLate(tick, dt)`,
    `#freezeReplayFrom: number` ; `#applyZone`, `#applyBossCharge`, `#applyDecoy` rendent
    désormais `number` (le tick d'où rejouer, ou `NO_REPLAY`) ;
  - disparaissent : `#drainPendingZones`, `#drainPendingCharges`, `#drainPendingDeaths`,
    `#applyDeaths`, `#freezeTouches`, et le commentaire `ponytail:` sur l'ordre des naissances ;
  - `#onResync` (étape 18) repart à neuf : anneau vidé puis `T`, journal vidé, `#freezeReplayFrom`
    oublié.

La séquence qui en sort, pour un pas `tick` (c'est la partie difficile ; tout le reste en découle) :

```
#advanceHorde(tick)
  #applyPendingOrders : seuls les ordres spawnTick === tick naissent (et vont au journal)
  rafraichissement du champ si du, horde.step(tick), tirs cosmetiques…
  #hordeHistory.record(tick)
  #replayLate(tick) :
    base = min( gel recu : fromTick − 1,
                ordre du passe tenu par l'anneau : spawnTick − 1   (-> au journal),
                zone / charge / leurre du passe tenus : bornTick / windupTick / bornTick,
                lot de morts tenu : deathTick )
    si base existe : restore(base) ; amorce du champ si base < tick ;
                     pour t de base a tick : (t > base) #replayTick(t) ; tuer les lots de t ; record(t)
    puis, au present : morts trop vieilles (lateDeaths), ordres trop vieux (lateOrders, clear de l'anneau)
#replayTick(t) : ordres du journal dates de t, PUIS rafraichissement si du, horde.step(t), record(t)
#replayFrom(fromTick) (a la reception d'un gel) : ne rejoue plus, note #freezeReplayFrom
#onResync(T) (etape 18) : anneau vide puis record(T), #spawned vide, #freezeReplayFrom oublie,
                          #pendingOrders vide (futur compris : deja dans l'instantane)
```

Pourquoi c'est juste : chaque effet qui ne dépend pas de la horde (zone, charge, leurre, bornes
du gel, ordre au journal) est posé **avant** le rejeu ; le seul effet qui dépend de la horde —
tuer — est appliqué à son tick, dans l'ordre des ticks ; une naissance est refaite à son tick par
le journal, quel que soit le rejeu qui repasse dessus. Le résultat ne dépend donc plus de l'ordre
d'arrivée des messages du lot. Un ordre en retard n'entre au journal que s'il est tenu par
l'anneau **après** l'enregistrement du pas (`holds` est lu en fin de pas) ; sinon il est approché
au présent (écart n° 3).

- [ ] **Étape 1 : écrire les tests**

À la fin de `front/src/net/client.test.ts`, ajouter :

```ts

describe('etape 17b : le journal des ordres et le rejeu unique', () => {
  const JOUEURS = [0, 1, 2, 3].map((i) => ({
    id: i,
    x: 3000 + i * 200,
    y: 3000,
    hp: 100,
    aimX: 0,
    aimY: 0,
    pickupRadius: ORB_PICKUP_RADIUS,
    shield: 0,
  }));

  function ouvrir(welcomeTick: number): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, welcomeTick, 0xd8a5_0017) });
    return { client, socket };
  }

  function vague(waveId: number, spawnTick: number, count = 10): WaveOrder {
    return {
      waveId,
      spawnTick,
      seed: 0x51ee_d000 + waveId,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 3000,
      anchorY: 3000,
      count,
    };
  }

  function image(client: GameClient, socket: FakeSocket, tick: number): void {
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, JOUEURS) });
    client.update(tick * STEP, STEP);
  }

  /** Une vague de 10 nee a l'heure au tick 0, puis les images `0..jusqua − 1`. */
  function avecUneVague(jusqua: number): { client: GameClient; socket: FakeSocket } {
    const { client, socket } = ouvrir(0);
    socket.emit('message', { data: encodeWaveOrder(vague(5, 0)) });
    for (let t = 0; t < jusqua; t++) {
      image(client, socket, t);
    }
    return { client, socket };
  }

  it('un petit ne dans le meme lot que la mort de son parent est present apres le rejeu', () => {
    const { client, socket } = avecUneVague(20);
    // Latence 1 : le salon a tue le parent a 18 et sorti ses petits pour 19.
    socket.emit('message', {
      data: encodeWaveOrder({
        ...vague(6, 19, 2),
        archetype: archetypeIdOf(SPLIT_CHILD),
        formation: FORMATION.POINT,
      }),
    });
    socket.emit('message', { data: encodeDeaths(18, [entityIdOf(5, 3)]) });
    image(client, socket, 20);
    expect(client.horde.slotOf(entityIdOf(5, 3))).toBe(-1);
    expect(client.horde.slotOf(entityIdOf(6, 0))).toBeGreaterThanOrEqual(0);
    expect(client.horde.slotOf(entityIdOf(6, 1))).toBeGreaterThanOrEqual(0);
    expect(client.horde.count).toBe(10 - 1 + 2);
  });

  it.each([
    { ordre: 17, mort: 18 },
    { ordre: 18, mort: 16 },
  ])('un lot qui apporte un ordre ($ordre) et une mort ($mort) en retard : UN rejeu, depuis le plus ancien', ({
    ordre,
    mort,
  }) => {
    const { client, socket } = avecUneVague(20);
    const step = vi.spyOn(client.horde, 'step');
    socket.emit('message', { data: encodeWaveOrder(vague(6, ordre, 4)) });
    socket.emit('message', { data: encodeDeaths(mort, [entityIdOf(5, 3)]) });
    image(client, socket, 20);
    // Le pas courant, puis UN rejeu de `min(ordre − 1, mort) + 1` a 20 inclus.
    expect(step).toHaveBeenCalledTimes(1 + 20 - Math.min(ordre - 1, mort));
    expect(client.horde.slotOf(entityIdOf(5, 3))).toBe(-1);
    expect(client.horde.slotOf(entityIdOf(6, 0))).toBeGreaterThanOrEqual(0);
    expect(client.horde.count).toBe(10 - 1 + 4);
  });

  it('une vague en retard dont la fenetre croise le debut d un gel : un rejeu, et la vague gele avec le monde', () => {
    const { client, socket } = ouvrir(5000);
    for (let t = 5000; t < 5006; t++) {
      image(client, socket, t);
    }
    // Espionne AVANT les messages : un rejeu a la reception compterait aussi.
    const step = vi.spyOn(client.horde, 'step');
    socket.emit('message', { data: encodeWaveOrder(vague(1, 5002)) });
    socket.emit('message', { data: encodeLevelUp(5004, 2) });
    image(client, socket, 5006);
    expect(step).toHaveBeenCalledTimes(1 + 5006 - 5001);
    // Nee a 5002, avancee a 5002 et 5003, gelee depuis 5004.
    const veille = new Horde(client.horde.capacity);
    expect(client.hordeAt(5003, veille)).toBe(true);
    const id = entityIdOf(1, 0);
    expect(client.horde.x[client.horde.slotOf(id)]).toBe(veille.x[veille.slotOf(id)]);
    expect(client.horde.y[client.horde.slotOf(id)]).toBe(veille.y[veille.slotOf(id)]);
  });

  it('un ordre plus vieux que l anneau nait au present, compte, et aucun rejeu ulterieur ne le perd', () => {
    const { client, socket } = ouvrir(5000);
    for (let t = 5000; t < 5012; t++) {
      image(client, socket, t);
    }
    socket.emit('message', { data: encodeWaveOrder(vague(1, 5001)) });
    image(client, socket, 5012);
    expect(client.horde.count).toBe(10);
    expect(client.lateOrders).toBe(1);
    // Datee d'avant sa naissance au present : plus rejouable, comptee.
    socket.emit('message', { data: encodeZone(ELEMENT.GIVRE, 3000, 3000, 5011, 1) });
    image(client, socket, 5013);
    expect(client.lateZones).toBe(1);
    expect(client.horde.count).toBe(10);
    // Une mort rejouable ensuite : la vague survit au rejeu.
    socket.emit('message', { data: encodeDeaths(5013, [entityIdOf(1, 2)]) });
    image(client, socket, 5014);
    expect(client.lateDeaths).toBe(0);
    expect(client.horde.count).toBe(9);
    expect(client.horde.slotOf(entityIdOf(1, 0))).toBeGreaterThanOrEqual(0);
  });

  it('un RESYNC repart a neuf : ni l anneau ni le journal d avant ne ressuscitent la horde', () => {
    const { client, socket } = ouvrir(0);
    socket.emit('message', { data: encodeWaveOrder(vague(5, 5)) });
    for (let t = 0; t < 10; t++) {
      image(client, socket, t);
    }
    // L'onglet revient (`RESYNC_REQUEST`) : l'etat complet du tick 4, sans la
    // vague 5 — le client, lui, a deja simule jusqu'a 9 avec elle.
    socket.emit('message', {
      data: encodeResync({
        tick: 4,
        level: 1,
        kills: 0,
        freezeUntilTick: -1,
        chestsOwed: 0,
        eventDraftsOwed: 0,
        draft: null,
        portal: null,
        event: null,
        charge: null,
        players: [],
        history: Array.from({ length: RESYNC_HISTORY_TICKS }, () => ({ ids: [], x: [], y: [] })),
        fieldTargets: [],
        horde: new Horde(1),
        orbs: [],
        zones: [],
        decoys: [],
      }),
    });
    // Une mort datee de 8, le futur du client : l'anneau ne doit plus tenir
    // son ancien 8.
    socket.emit('message', { data: encodeDeaths(8, [entityIdOf(5, 0)]) });
    image(client, socket, 5);
    expect(client.horde.count).toBe(0);
    image(client, socket, 6);
    // Un gel en retard qui fait rejouer depuis 4 : le journal ne doit plus
    // refaire naitre la vague 5 a son tick.
    socket.emit('message', { data: encodeLevelUp(5, 2) });
    image(client, socket, 7);
    expect(client.horde.count).toBe(0);
  });
});
```

(`Horde`, `entityIdOf`, `archetypeIdOf`, `SPLIT_CHILD`, `ELEMENT`, `encodeDeaths`, `encodeZone`,
`encodeLevelUp`, `encodeResync`, `RESYNC_HISTORY_TICKS` sont déjà importés en tête du fichier.)

Puis modifier deux tests existants, qui exigeaient l'ancien rattrapage :

`it('calcule un rattrapage non nul pour un ordre emis avant le tick local courant', …)` (l.195) :
remplacer le commentaire

```ts
    // L'ordre a ete emis au tick serveur 5000 : le client, qui en est
    // maintenant a 5002, doit rattraper deux pas.
```

par

```ts
    // L'ordre a ete emis au tick serveur 5000 : le client, qui en est
    // maintenant a 5002, n'a aucun instantane de 4999 dans son anneau. Etape
    // 17b : il nait au present, en fin de pas, et rattrape 5000, 5001 et 5002
    // (ce dernier vient d'etre simule sans lui) — compte dans `lateOrders`.
```

le `2,` qui suit `expect.objectContaining({ spawnTick: 5000 }),` (l.232) par `3,`, et ajouter
après `expect(client.horde.count).toBe(10);` (l.246) :

```ts
    expect(client.lateOrders).toBe(1);
```

Le `describe('etape 17, revue 2 : une vague en retard ne rejoue la horde que si un gel touche sa
fenetre', …)` (l.5616) : remplacer son titre et son docbloc

```ts
describe('etape 17, revue 2 : une vague en retard ne rejoue la horde que si un gel touche sa fenetre', () => {
  /**
   * Le chemin cher (restaurer, faire naitre, rejouer toute la horde) se
   * reconnait a son `spawnCatchingUp(order, 0, …)` ; le rattrapage ordinaire
   * passe les pas manques, `missed > 0`.
   */
```

par

```ts
describe('etape 17b : toute vague en retard dans l anneau passe par le rejeu (revue 2 de l etape 17, inversee)', () => {
  /**
   * Le rejeu (restaurer, faire naitre a son tick, rejouer toute la horde) se
   * reconnait a son `spawnCatchingUp(order, 0, …)` ; le rattrapage approche,
   * reserve aux ordres plus vieux que l'anneau, passe les pas manques.
   */
```

et le test qui s'inverse (l.5650-5652)

```ts
  it('vague ordinaire en retard : rattrapage des seules nouvelles entites, aucun rejeu', () => {
    expect(rattrapage(null)).toEqual([4]);
  });
```

par

```ts
  it('vague ordinaire en retard : rejeu, elle nait a son tick', () => {
    expect(rattrapage(null)).toEqual([0]);
  });
```

(Son voisin « un gel dans la fenêtre (LEVEL_UP daté 5004) : rejeu » attend déjà `[0]` et ne change
pas.)

- [ ] **Étape 2 : les voir échouer**

Run : `cd front && npx vitest run src/net/client.test.ts`
Attendu : 8 échecs, tous attendus — `expected -1 to be greater than or equal to 0` (le petit perdu
par le rejeu de la mort, deux fois), `expected "step" to be called 5 times, but got 3 times`,
`expected "step" to be called 6 times, but got 7 times` (deux rejeux au lieu d'un),
`expected undefined to be 1` (`lateOrders`), le rattrapage non nul (`… 3, …(5)`),
`expected [ 4 ] to deeply equal [ +0 ]`, et `expected 9 to be +0` (le `RESYNC` : la mort datée du
futur restaure le 8 périmé de l'anneau). Mesuré à `44e4e9b` + tâches 1 à 3.

- [ ] **Étape 3 : `holds` et `clear` dans l'anneau**

`shared/horde-history.ts`, dans `restore` (l.69-80), remplacer

```ts
    const slot = this.#slotOf(tick);
    if (this.#ticks[slot] !== tick) {
      return false;
    }
    const state = this.#states[slot];
```

par

```ts
    if (!this.holds(tick)) {
      return false;
    }
    const state = this.#states[this.#slotOf(tick)];
```

et ajouter, juste avant `/** Le plus vieux tick actuellement tenu par l'anneau, ou -1 s'il est vide. */` :

```ts
  /** Vrai si l'anneau tient ce tick precis : `restore(tick)` reussira. */
  holds(tick: number): boolean {
    return this.#ticks[this.#slotOf(tick)] === tick;
  }

  /**
   * Oublie tous les ticks tenus : plus aucun `restore` ne reussit avant le
   * prochain `record`. Pour un changement applique au present qu'un rejeu
   * ulterieur, reparti d'avant lui, effacerait (`GameClient#replayLate`).
   */
  clear(): void {
    this.#ticks.fill(-1);
  }

```

- [ ] **Étape 4 : constante, champs, getter**

`front/src/net/client.ts`, après `const FIXED_DT = 1 / TICK_HZ;` (l.233) :

```ts

/** Etape 17b : « aucun tick a restaurer » pour le rejeu unique (`GameClient#replayLate`). */
const NO_REPLAY = Number.MAX_SAFE_INTEGER;
```

Après `#lateFreezes = 0;` (l.1553) :

```ts
  /** Voir le getter `lateOrders`. */
  #lateOrders = 0;
  /**
   * Etape 17b : le premier tick d'un gel recu en retard (`#replayFrom`), a
   * rejouer avec le reste au rejeu unique de fin de pas (`#replayLate`).
   */
  #freezeReplayFrom = Number.MAX_SAFE_INTEGER;
```

Le docbloc de `#pendingOrders` (l.1631-1633) :

```ts
   * Le gestionnaire de message ne fait QUE empiler. L'application a lieu dans
   * `#advanceHorde`, avant le rafraichissement du champ — l'ordre inverse
   * multiplie la derive par trente-cinq.
```

devient

```ts
   * Le gestionnaire de message ne fait QUE empiler. Un ordre de CE tick nait
   * dans `#advanceHorde`, avant le rafraichissement du champ — l'ordre inverse
   * multiplie la derive par trente-cinq ; un ordre du passe, au rejeu unique
   * de fin de pas (`#replayLate`) ; un ordre du futur attend son tick.
```

et, après `readonly #pendingOrders: WaveOrderMessage[] = [];` (l.1635) :

```ts

  /**
   * Etape 17b : le journal des ordres nes, tries comme au salon (`spawnTick`,
   * puis l'arrivee). `#replayTick` y refait naitre les ordres de son tick :
   * sans lui, un rejeu reparti d'avant une naissance la perdrait pour toujours.
   * Elague au-dela de l'anneau (`#journal`).
   */
  readonly #spawned: WaveOrderMessage[] = [];
```

Entre le getter `lateFreezes` et `hordeAt` (tâche 1) :

```ts

  /**
   * Etape 17b : ordres de vague arrives trop tard pour l'anneau
   * (`ROLLBACK_DEPTH_TICKS`), nes au present par rattrapage approche. Meme
   * degradation signalee que `lateDeaths`. Voir `#replayLate`.
   */
  get lateOrders(): number {
    return this.#lateOrders;
  }
```

- [ ] **Étape 5 : `#advanceHorde`**

Le commentaire de tête (l.3122-3125)

```ts
    // ⚠️ LES ORDRES EN ATTENTE S'APPLIQUENT ICI, EN PREMIER, avant le
    // rafraichissement du champ : dans l'ordre inverse, la derive due a la
    // latence devient pire que sans rattrapage du tout. C'est la raison de la
    // file plutot qu'une application a la reception.
```

devient

```ts
    // ⚠️ LES ORDRES DE CE TICK NAISSENT ICI, EN PREMIER, avant le
    // rafraichissement du champ — l'ordre de `Room#step` (etape 17b). Ceux du
    // passe attendent le rejeu unique de fin de pas (`#replayLate`).
```

et la fin de la fonction (l.3283-3294)

```ts
    this.#hordeHistory.record(tick, this.horde);
    this.#drainPendingZones(tick);
    this.#drainPendingCharges(tick);
    // Les leurres reecrivent l'anneau comme une charge : AVANT les morts.
    while (this.#pendingDecoys.length > 0) {
      const decoy = this.#pendingDecoys.shift();
      if (decoy) {
        this.#applyDecoy(decoy, tick);
      }
    }
    this.#drainPendingDeaths(tick);
  }
```

devient

```ts
    this.#hordeHistory.record(tick, this.horde);
    this.#replayLate(tick, dt);
  }
```

- [ ] **Étape 6 : le rejeu unique, à la place des drains et de `#applyDeaths`**

Remplacer **tout** le bloc qui va du docbloc `/**\n   * Applique toutes les zones recues mais pas
encore posees, au tick local` (l.3842) jusqu'à la fin de `#applyDeaths` (l.4030, la ligne vide
l.4031 comprise) — soit `#drainPendingZones`, `#applyZone`, `#drainPendingCharges`, `#applyBossCharge`,
`#drainPendingDeaths`, `#applyDeaths` et leurs docblocs — par ce qui suit ; le docbloc
`/**\n   * Oublie la charge en cours si c'est SON boss qui vient de mourir.` (l.4032) reste juste
après :

```ts
  /**
   * Etape 17b : **UN SEUL rejeu par pas**, en fin de pas, pour tout ce qui
   * est arrive en retard : ordres de vague, zones, charges, leurres, morts, et
   * le gel recu par `#replayFrom`.
   *
   * Chaque retard pose d'abord ce qui ne depend pas de la horde (la zone, la
   * charge, le leurre, l'ordre au journal, les bornes du gel) et rend le tick
   * d'ou repartir ; la horde repart UNE fois du plus ancien, refait naitre les
   * ordres du journal a leur tick (`#replayTick`), tue chaque lot de morts a
   * son tick, et rejoue jusqu'au present. Un seul passage, dans l'ordre des
   * ticks : plus d'ordre d'application a respecter entre zones, charges et
   * morts (avant l'etape 17b, une mort rejouee avant une zone plus ancienne
   * etait perdue).
   *
   * Hors de l'anneau (`ROLLBACK_DEPTH_TICKS`) : applique au present, et
   * COMPTE (`lateDeaths`, `lateZones`, `lateCharges`, `lateDecoys`,
   * `lateFreezes`, `lateOrders`). Un ordre trop vieux vide l'anneau : un rejeu
   * ulterieur reparti d'avant sa naissance approchee le perdrait.
   *
   * ⚠️ Le rejeu ne rejoue QUE le mouvement — champ, horde, separation — jamais
   * l'arbitrage (degats, contact, ramassages), prerogative du serveur.
   */
  #replayLate(tick: number, dt: number): void {
    let base = NO_REPLAY;
    // Le gel recu en retard : ses bornes sont deja posees (`#freezeFrom`,
    // `#thawAt`), et `#replayFrom` a verifie que l'anneau le tient encore.
    if (this.#freezeReplayFrom !== NO_REPLAY) {
      base = this.#freezeReplayFrom - 1;
      this.#freezeReplayFrom = NO_REPLAY;
    }
    // Les ordres du passe (`#applyPendingOrders` ne fait naitre que ceux du
    // tick) : au journal, ils naitront a leur tick pendant le rejeu.
    const tooOld: WaveOrderMessage[] = [];
    if (this.#pendingOrders.length > 0) {
      for (const order of this.#pendingOrders.splice(0)) {
        if (order.spawnTick > tick) {
          this.#pendingOrders.push(order);
        } else if (this.#hordeHistory.holds(order.spawnTick - 1)) {
          this.#journal(order, tick);
          base = Math.min(base, order.spawnTick - 1);
        } else {
          tooOld.push(order);
        }
      }
    }
    for (const zone of this.#pendingZones.splice(0)) {
      base = Math.min(base, this.#applyZone(zone, tick));
    }
    for (const charge of this.#pendingCharges.splice(0)) {
      base = Math.min(base, this.#applyBossCharge(charge, tick));
    }
    for (const decoy of this.#pendingDecoys.splice(0)) {
      base = Math.min(base, this.#applyDecoy(decoy, tick));
    }
    const deaths: PendingDeathBatch[] = [];
    const tooOldDeaths: PendingDeathBatch[] = [];
    for (const batch of this.#pendingDeaths.splice(0)) {
      this.#kills += batch.ids.length;
      if (this.#hordeHistory.holds(batch.tick)) {
        deaths.push(batch);
        base = Math.min(base, batch.tick);
      } else {
        tooOldDeaths.push(batch);
      }
    }

    // Tri stable par tick de mort : la boucle ci-dessous les tue dans l'ordre.
    deaths.sort((a, b) => a.tick - b.tick);
    if (base !== NO_REPLAY) {
      this.#hordeHistory.restore(base, this.horde);
      // ⚠️ Le champ n'est pas dans l'anneau : sans cette amorce, le rejeu
      // partirait du champ du DERNIER rafraichissement reel. Inutile (et
      // nuisible au garde de `spawnCatchingUp`) quand rien n'est rejoue.
      if (base < tick) {
        this.#primeFieldForReplay(base);
      }
      let d = 0;
      for (let t = base; t <= tick; t++) {
        if (t > base) {
          this.#replayTick(t);
        }
        for (let batch = deaths[d]; batch && batch.tick === t; batch = deaths[++d]) {
          // Les orbes a la position restauree, juste avant `kill`, comme
          // `resolveProjectileDamage` au salon (voir `back/src/combat.ts`).
          this.#spawnOrbs(batch.ids, t);
          this.horde.kill(batch.ids);
          this.#forgetChargeOf(batch.ids);
          // ⚠️ Reecrire le creneau de la mort lui-meme : un rejeu suivant qui
          // le restaurerait y retrouverait sinon les victimes vivantes.
          this.#hordeHistory.record(t, this.horde);
        }
      }
    }

    // Trop vieux pour l'anneau : au present, APRES le rejeu (qui sinon les
    // effacerait), et comptes.
    for (const batch of tooOldDeaths) {
      this.#spawnOrbs(batch.ids, batch.tick);
      this.#lateDeaths += batch.ids.length;
      this.horde.kill(batch.ids);
      this.#forgetChargeOf(batch.ids);
    }
    // Tri stable : a tick egal, l'ordre d'arrivee, celui du salon. Les pas
    // `spawnTick..tick` rattrapes : le pas `tick` vient d'etre fait sans eux.
    tooOld.sort((a, b) => a.spawnTick - b.spawnTick);
    for (const order of tooOld) {
      this.#lateOrders++;
      this.horde.spawnCatchingUp(
        order,
        tick + 1 - order.spawnTick,
        dt,
        this.#fields,
        this.zones,
        this.#bossCharge,
        (t) => this.#movementScale(t),
      );
    }
    if (tooOld.length > 0) {
      this.#hordeHistory.clear();
    }
    if (tooOldDeaths.length > 0 || tooOld.length > 0) {
      this.#hordeHistory.record(tick, this.horde);
    }
  }

  /**
   * Pose une zone annoncee et rend le tick d'ou rejouer (`#replayLate`), ou
   * `NO_REPLAY`.
   *
   * ⚠️ **L'effet est DATE PAR TICK, jamais applique a la reception.** Le
   * serveur ralentit depuis `bornTick` ; le message arrive quelques ticks plus
   * tard. L'appliquer au present ferait diverger le client de sa latence
   * exacte, sur un effet qui touche le DEPLACEMENT.
   *
   * `bornTick >= currentTick` : rien a rejouer. Une zone ne ralentit qu'a
   * partir du tick SUIVANT sa pose (voir `ZoneField.slowsAt`), donc son effet
   * est encore entierement devant nous.
   *
   * La zone est posee AVANT le rejeu, sans quoi le rejeu avancerait la horde
   * sans elle et ne corrigerait rien.
   */
  #applyZone(zone: ZoneMessage, currentTick: number): number {
    this.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
    if (zone.bornTick >= currentTick) {
      return NO_REPLAY;
    }
    if (!this.#hordeHistory.holds(zone.bornTick)) {
      // Trop vieux pour l'anneau : posee au present, et SIGNALEE — meme
      // degradation assumee que pour une mort trop vieille. Voir `#lateZones`.
      this.#lateZones++;
      return NO_REPLAY;
    }
    return zone.bornTick;
  }

  /**
   * Installe une charge annoncee et rend le tick d'ou rejouer (`#replayLate`),
   * ou `NO_REPLAY`.
   *
   * ⚠️ **UNE CHARGE DEPLACE LE BOSS.** L'installer au present ferait deriver
   * le boss de la latence exacte du message pendant tout le reste de la
   * traversee — et le rejeu ramene cet ecart a zero (scenario 11 de
   * `shared/horde.replication.test.ts`).
   *
   * `windupTick >= currentTick` : rien a rejouer. C'est le cas NOMINAL, le
   * chargement (`BOSS_CHARGE_WINDUP_TICKS`) durant bien plus que le trajet
   * d'un message.
   */
  #applyBossCharge(msg: BossChargeMessage, currentTick: number): number {
    const charge: BossCharge = {
      entityId: msg.entityId,
      x: msg.x,
      y: msg.y,
      dirX: msg.dirX,
      dirY: msg.dirY,
      length: msg.length,
      width: msg.width,
      windupTick: msg.windupTick,
      startTick: msg.startTick,
      endTick: msg.endTick,
    };
    this.#bossCharge = charge;
    if (charge.windupTick >= currentTick) {
      return NO_REPLAY;
    }
    if (!this.#hordeHistory.holds(charge.windupTick)) {
      // Trop vieille pour l'anneau : installee au present, et SIGNALEE.
      this.#lateCharges++;
      return NO_REPLAY;
    }
    return charge.windupTick;
  }

```

- [ ] **Étape 7 : `#applyDecoy` rend son tick**

Remplacer `#applyDecoy` et son docbloc (de `/**\n   * Plante un leurre annonce, par rejeu` l.4116
à la `}` de la fonction l.4148) par :

```ts
  /**
   * Plante un leurre annonce et rend le tick d'ou rejouer (`#replayLate`), ou
   * `NO_REPLAY` — le patron de `#applyBossCharge`, eprouve a 0,000 px par le
   * scenario AP2 de `shared/horde.replication.test.ts`.
   *
   * Un leurre n'agit que sur des positions de `bornTick` ou plus recentes, et
   * l'entree du champ est lue `FIELD_INPUT_DELAY_TICKS` en retard : tant que
   * l'annonce arrive dans ce delai, aucun pas deja simule ne l'a manque. Au-dela,
   * le rejeu unique repart de la naissance du leurre.
   */
  #applyDecoy(decoy: Decoy, currentTick: number): number {
    // Garde un leurre au-dela de sa vie le temps qu'un rejeu puisse encore
    // revisiter ses ticks (`ROLLBACK_DEPTH_TICKS`) : `substituteDecoys` ignore
    // de toute facon un leurre expire au tick des positions.
    this.#decoys = this.#decoys.filter(
      (d) =>
        currentTick - d.bornTick <
        DECOY_LIFETIME_TICKS + FIELD_INPUT_DELAY_TICKS + ROLLBACK_DEPTH_TICKS,
    );
    this.#decoys.push(decoy);
    if (decoy.bornTick >= currentTick) {
      return NO_REPLAY;
    }
    if (!this.#hordeHistory.holds(decoy.bornTick)) {
      // Trop vieux pour l'anneau : plante au present, et SIGNALE — meme
      // degradation assumee que pour une charge ou une zone trop vieille.
      this.#lateDecoys++;
      return NO_REPLAY;
    }
    return decoy.bornTick;
  }

```

- [ ] **Étape 8 : `#replayTick`, `#applyPendingOrders` et le journal**

Remplacer tout ce qui va du docbloc `/**\n   * Un pas de rejeu : rafraichit le champ si du`
(l.4150) jusqu'à la `}` de `#freezeTouches` (l.4250, la ligne vide l.4251 comprise) — donc
`#replayTick`, `#applyPendingOrders` (et la version de la tâche 3), `#freezeTouches` et le
commentaire `ponytail:` sur l'ordre des naissances — par ce qui suit ; le docbloc
`/**\n   * Un gel commence a \`startTick\`` (l.4252) reste juste après :

```ts
  /**
   * Un pas de rejeu : fait renaitre les ordres du journal dates de ce tick,
   * rafraichit le champ si du, recalcule la trajectoire des entites en phase
   * puis avance la horde — les etapes 4 a 6 de la sequence serveur, jamais
   * l'arbitrage (7 a 9). Reecrit aussi l'anneau pour ce tick :
   * une mort suivante qui viserait l'un de ces ticks doit restaurer la
   * version rejouee, pas l'ancienne version d'avant correction.
   *
   * ⚠️ `tick` doit etre le meme tick ABSOLU que celui utilise par la
   * simulation d'origine (voir `Horde.step`) : c'est lui qui determine la
   * phase de recalcul de trajectoire, pas un compteur propre au rejeu.
   */
  #replayTick(tick: number): void {
    // Etape 17b : les ordres de ce tick renaissent d'abord, AVANT le
    // rafraichissement, comme au salon et au pas courant.
    for (const order of this.#spawned) {
      if (order.spawnTick === tick) {
        this.horde.spawnCatchingUp(order, 0, FIXED_DT, this.#fields);
      }
    }
    if (tick > this.#untilAt(tick) && tick % STEPS_PER_FIELD === 0) {
      this.#feedFields(tick, true);
    }
    const scale = this.#movementScale(tick);
    this.horde.step(FIXED_DT * scale, this.#fields, tick, this.zones, this.#bossCharge);
    this.#hordeHistory.record(tick, this.horde);
  }

  /**
   * Fait naitre les ordres DE ce tick, avant le rafraichissement du champ —
   * l'ordre du salon (`Room#step`, etape 17b) — et les inscrit au journal.
   *
   * Etape 17b : un ordre du FUTUR (un petit ne a `T + 1`, ou une horloge en
   * retard sur le salon) reste en file jusqu'a son tick ; un ordre du PASSE
   * attend le rejeu unique de fin de pas (`#replayLate`), qui le fait naitre a
   * son tick exact. Plus de rattrapage approche dans l'anneau.
   */
  #applyPendingOrders(tick: number, dt: number): void {
    // Rien a faire la plupart des ticks.
    if (this.#pendingOrders.length === 0) {
      return;
    }
    let kept = 0;
    for (const order of this.#pendingOrders) {
      if (order.spawnTick === tick) {
        this.horde.spawnCatchingUp(order, 0, dt, this.#fields);
        this.#journal(order, tick);
      } else {
        this.#pendingOrders[kept++] = order;
      }
    }
    this.#pendingOrders.length = kept;
  }

  /**
   * Inscrit un ordre au journal, a sa place : apres tous ceux de `spawnTick`
   * inferieur ou egal (a tick egal, l'ordre d'arrivee, celui du salon).
   * Elague ce qu'aucun rejeu ne peut plus revisiter : l'anneau ne remonte pas
   * au-dela de `tick − ROLLBACK_DEPTH_TICKS`.
   */
  #journal(order: WaveOrderMessage, tick: number): void {
    while ((this.#spawned[0]?.spawnTick ?? tick) < tick - ROLLBACK_DEPTH_TICKS) {
      this.#spawned.shift();
    }
    let at = this.#spawned.length;
    while (at > 0 && (this.#spawned[at - 1]?.spawnTick ?? 0) > order.spawnTick) {
      at--;
    }
    this.#spawned.splice(at, 0, order);
  }

```

- [ ] **Étape 9 : `#replayFrom` ne rejoue plus à la réception, et deux commentaires**

Remplacer `#replayFrom` et son docbloc (de `/**\n   * Rejoue depuis \`fromTick\`` l.4285 à la `}`
de la fonction l.4306) par :

```ts
  /**
   * Fait rejouer depuis `fromTick`, avec les bornes qui viennent d'arriver, les
   * ticks que la horde a DEJA simules. Rien si elle ne l'a pas encore atteint.
   * Etape 17b : plus a la reception — au rejeu unique du prochain pas
   * (`#replayLate`), avec les morts et les ordres du meme lot. Le garde
   * `> lastHordeTick − ROLLBACK_DEPTH_TICKS` dit que l'anneau tiendra encore
   * `fromTick − 1` apres l'enregistrement de ce pas.
   *
   * ponytail: trop vieux pour l'anneau (`ROLLBACK_DEPTH_TICKS`), on ne rejoue
   * pas et l'ecart reste, compte dans `lateFreezes` ; l'afficher au HUD comme
   * `lateDeaths` si ca se voit.
   */
  #replayFrom(fromTick: number): void {
    const current = this.#lastHordeTick - 1;
    if (fromTick > current) {
      return;
    }
    if (
      fromTick - 1 <= this.#lastHordeTick - ROLLBACK_DEPTH_TICKS ||
      !this.#hordeHistory.holds(fromTick - 1)
    ) {
      this.#lateFreezes++;
      return;
    }
    this.#freezeReplayFrom = Math.min(this.#freezeReplayFrom, fromTick);
  }
```

Le garde `fromTick − 1 <= lastHordeTick − ROLLBACK_DEPTH_TICKS` garantit que l'anneau tiendra
encore `fromTick − 1` après l'enregistrement du prochain pas ; le test existant « revue 1 : un
gel trop vieux pour l'anneau se compte dans lateFreezes » (l.5256) le compte toujours **à la
réception**.

Puis `GameClient#applyDeaths` (l.379) et `voir \`#applyDeaths\`` (l.2668) deviennent
`GameClient#replayLate` et `voir \`#replayLate\``.

- [ ] **Étape 9 bis : le `RESYNC` repart à neuf (étape 18)**

`#onResync` (étape 18) pose la horde de `T` et l'inscrit à l'anneau, mais un onglet revenu
(`RESYNC_REQUEST`) a pu simuler au-delà de `T` avec sa horde périmée. Dans `#onResync`, remplacer

```ts
    // L'anneau connait `T` : un message date `T + 1` en retard peut rejouer.
    this.#hordeHistory.record(T, this.horde);
```

par

```ts
    // L'anneau connait `T` : un message date `T + 1` en retard peut rejouer.
    // Etape 17b : et RIEN d'autre. Un onglet revenu (`RESYNC_REQUEST`) a pu
    // simuler au-dela de `T` avec sa horde perimee : un rejeu qui restaurerait
    // l'un de ces ticks la ressusciterait, et le journal (`#spawned`) referait
    // naitre des ordres deja dans l'instantane. Un gel note pour le rejeu
    // (`#freezeReplayFrom`) visait l'ancien anneau.
    this.#hordeHistory.clear();
    this.#hordeHistory.record(T, this.horde);
    this.#spawned.length = 0;
    this.#freezeReplayFrom = NO_REPLAY;
```

Dans la même fonction, deux commentaires rendus faux ou incomplets — le premier

```ts
    // L'historique des positions : les enregistrements que le serveur a faits
    // (un tick gele n'en fait pas — un enregistrement vide ne vaut pas un
    // enregistrement absent, `delayed` s'accroche au precedent).
```

devient

```ts
    // L'historique des positions : les enregistrements que le serveur a faits,
    // ticks geles compris (etape 17b, `Room#recordHistory`). Une entree vide
    // n'est pas enregistree : vide ne vaut pas absent, `delayed` s'accroche au
    // precedent.
```

et le second

```ts
    // Tout ce qui est date `<= T` est dans l'instantane : une vague deja nee
    // renaitrait, une mort deja compactee tuerait un autre creneau.
```

devient (le vidage de `#pendingOrders` qui suit ne change pas)

```ts
    // Tout ce qui est date `<= T` est dans l'instantane : une vague deja nee
    // renaitrait, une mort deja compactee tuerait un autre creneau. Etape 17b :
    // les ordres du futur aussi — le salon n'en draine qu'a `T + 1` (les
    // petits), qu'il a deja inseres dans sa horde a la fin de `T`.
```

- [ ] **Étape 10 : les commentaires des autres fichiers**

Ils nommaient les fonctions disparues, et deux d'entre eux une raison qui ne vaut plus (écart
n° 9) ; la référence du `RESYNC` de l'étape 18 (`client.test.ts`) recopiait l'ordre d'avant de
`Room.step` et citait le `ponytail:` supprimé à l'étape 8 (réconciliation, point 8). Depuis la racine du worktree, lancer ce script (il échoue si un texte attendu manque) :

```bash
python3 - <<'PYEOF'
# Etape 17b, tache 4 : les commentaires qui nommaient les anciens rejeux du client.
import pathlib

PAIRES = {
    'back/src/combat.ts': [
        (
            " * avec celles des projectiles et des brulures, car\n"
            " * `GameClient#drainPendingDeaths` suppose un seul lot par tick.\n",
            " * avec celles des projectiles et des brulures — un seul lot par tick sur le\n"
            " * fil (`GameClient#replayLate` les rejoue de toute facon dans l'ordre).\n",
        ),
        (
            " * avec celles des projectiles, car `GameClient#drainPendingDeaths` suppose un\n"
            " * seul `DEATHS` par tick (un lot rejoue apres un autre effacerait la\n"
            " * correction du premier).\n",
            " * avec celles des projectiles — un seul `DEATHS` par tick sur le fil\n"
            " * (`GameClient#replayLate` les rejoue de toute facon dans l'ordre).\n",
        ),
    ],
    'back/src/room.ts': [
        (
            "    // ⚠️ **UN SEUL lot de morts par tick, toutes passes comprises.**\n"
            "    // `GameClient` s'appuie dessus : deux lots vises au meme tick, rejoues\n"
            "    // l'un apres l'autre, verraient le second effacer la correction du premier\n"
            "    // (`#drainPendingDeaths`). Aucune passe n'a donc de chemin de mort a elle.\n",
            "    // ⚠️ **UN SEUL lot de morts par tick, toutes passes comprises** : la regle\n"
            "    // du fil (`GameClient#replayLate` rejoue de toute facon les lots dans\n"
            "    // l'ordre des ticks). Aucune passe n'a donc de chemin de mort a elle.\n",
        ),
    ],
    'back/src/room.test.ts': [
        (
            "**Le rejeu client en depend** : `GameClient#drainPendingDeaths`\n"
            "    // suppose « un seul lot par tick » et rejouerait le second par-dessus la\n"
            "    // correction du premier.",
            "**La regle du fil** : un seul lot `DEATHS` par tick\n"
            "    // (`GameClient#replayLate` les rejoue de toute facon dans l'ordre).",
        ),
        (
            "    // DEUX chemins tuent. `GameClient#drainPendingDeaths` suppose « un seul lot\n"
            "    // par tick » et rejouerait le second par-dessus la correction du premier.\n",
            "    // DEUX chemins tuent : la regle du fil est un seul lot par tick\n"
            "    // (`GameClient#replayLate` les rejoue de toute facon dans l'ordre).\n",
        ),
    ],
    'shared/horde.replication.test.ts': [
        ("   * de `GameClient#applyDeaths`.\n", "   * de `GameClient#replayLate`.\n"),
    ],
    'front/src/net/client.test.ts': [
        (
            "      // n'y distingue `#drainPendingDeaths` qui vide la file de sa mutation\n",
            "      // n'y distingue `#replayLate` qui vide la file de sa mutation\n",
        ),
        (
            "tuee est toujours vivante — la mort disparait. Les zones passent donc\n"
            "    // AVANT (voir `GameClient#drainPendingZones`).\n",
            "tuee est toujours vivante — la mort disparait. Etape 17b : un seul\n"
            "    // rejeu applique tout dans l'ordre des ticks (`GameClient#replayLate`).\n",
        ),
        (
            "      // ⚠️ L'ordre du CLIENT (les vagues avant le champ), PAS celui de\n"
            "      // `Room#step`, qui fait naitre ses vagues APRES le rafraichissement du\n"
            "      // champ et le reciblage : un ecart anterieur a l'etape 17, documente\n"
            "      // dans `GameClient#applyPendingOrders`. Cette reference mesure le\n"
            "      // rejeu du gel, pas cet ecart.\n",
            "      // Les vagues avant le champ : l'ordre de `Room#step` depuis l'etape\n"
            "      // 17b, et celui du client.\n",
        ),
        # La reference du `RESYNC` (etape 18) recopiait l'ordre d'avant de `Room.step`.
        (
            "  /** Un pas du serveur de reference, dans l'ordre de `Room.step` : champ, vagues, horde. */\n"
            "  function pasDeReference(ref: ReferenceServer, tick: number, orders: readonly WaveOrder[]): void {\n"
            "    if (tick % STEPS_PER_FIELD === 0) {\n",
            "  /** Un pas du serveur de reference, dans l'ordre de `Room.step` (etape 17b) : vagues, champ, horde. */\n"
            "  function pasDeReference(ref: ReferenceServer, tick: number, orders: readonly WaveOrder[]): void {\n"
            "    for (const o of orders) {\n"
            "      if (o.spawnTick === tick) {\n"
            "        ref.horde.spawn(o, ref.fields[0]);\n"
            "      }\n"
            "    }\n"
            "    if (tick % STEPS_PER_FIELD === 0) {\n",
        ),
        (
            "        ref.horde.retarget(seen.x, seen.y);\n"
            "      }\n"
            "    }\n"
            "    for (const o of orders) {\n"
            "      if (o.spawnTick === tick) {\n"
            "        ref.horde.spawn(o, ref.fields[0]);\n"
            "      }\n"
            "    }\n"
            "    ref.horde.step(STEP, ref.fields, tick);\n",
            "        ref.horde.retarget(seen.x, seen.y);\n"
            "      }\n"
            "    }\n"
            "    ref.horde.step(STEP, ref.fields, tick);\n",
        ),
        (
            "    // Des ticks qui ne sont PAS des rafraichissements : voir la note ponytail\n"
            "    // de `GameClient#applyPendingOrders` (ecart anterieur a l'etape 17).\n",
            "    // Des ticks qui ne sont PAS des rafraichissements (avant l'etape 17b, le\n"
            "    // salon y faisait naitre APRES le champ, le client avant).\n",
        ),
    ],
}

for chemin, paires in PAIRES.items():
    f = pathlib.Path(chemin)
    s = f.read_text()
    for ancien, nouveau in paires:
        n = s.count(ancien)
        assert n >= 1, (chemin, ancien[:60])
        s = s.replace(ancien, nouveau)
    f.write_text(s)
print('ok')
PYEOF
grep -rn "drainPending\|#applyDeaths\|freezeTouches\|lastPositions\|note ponytail\|champ, vagues" back/src front/src shared
```

Attendu : `ok`, puis aucune ligne pour le `grep`.

- [ ] **Étape 11 : les tests passent**

Run : `cd front && npx vitest run src/net/client.test.ts src/net/verbes.test.ts src/net/carte.test.ts src/net/evenement.test.ts src/net/ping.test.ts`
Attendu : tout vert (167 + 41 tests, mesuré à `44e4e9b`), dont le test de l'étape 18 « suit la
reference a 0,000 px sur 300 ticks » avec sa référence remise à l'ordre du salon.

Run : `cd back && npx vitest run ../shared/horde-history.test.ts`
Attendu : vert.

Run : `cd front && npx tsc --noEmit`
Attendu : aucune erreur (les trois `#apply*` rendent `number` partout où ils sont appelés).

- [ ] **Étape 12 : tout basculer**

`front/src/net/room-client.replication.test.ts` : plus aucun `it.fails` —

```ts
it.each([0, 1, 2, 3])(LATENCE, latence);
```

à la place des deux lignes `it.each([0])(LATENCE, latence);` / `it.fails.each([1, 2, 3])(LATENCE, latence);` ;
`it.fails('hoquet d une image …` devient `it('hoquet d une image …` ; et

```ts
it.each([0, 2])(PORTAIL, portail);
```

à la place de `it.each([0])(PORTAIL, portail);` / `it.fails.each([2])(PORTAIL, portail);`.

Run : `cd front && npx vitest run src/net/room-client.replication.test.ts`
Attendu : `Tests  12 passed (12)`, chaque ligne `[etape 17b] …` à `ecart regle 0.000 px, 0
perdues`. Mesuré à `44e4e9b`.

- [ ] **Étape 13 : commit**

```bash
npx biome check --write shared/horde-history.ts front/src/net/client.ts front/src/net/client.test.ts \
  front/src/net/room-client.replication.test.ts back/src/combat.ts back/src/room.ts back/src/room.test.ts \
  shared/horde.replication.test.ts
git add shared/horde-history.ts front/src/net/client.ts front/src/net/client.test.ts \
  front/src/net/room-client.replication.test.ts back/src/combat.ts back/src/room.ts back/src/room.test.ts \
  shared/horde.replication.test.ts
git commit -m "fix(front): le journal des ordres et un seul rejeu par pas, vagues en retard exactes"
```

---

### Tâche 5 : le livrable — douze scénarios à 0,000 px, et six contre-épreuves

**Fichiers :**
- Aucun changement commité. Modifications **temporaires** de `back/src/room.ts` et
  `front/src/net/client.ts`, chacune annulée par `git restore` avant la suivante.

**Interfaces :**
- Consomme : les tâches 1 à 4, commitées.
- Produit : les chiffres du livrable et des contre-épreuves, pour le bilan (tâche 6).

- [ ] **Étape 1 : le livrable**

Run : `grep -c "it.fails" front/src/net/room-client.replication.test.ts`
Attendu : `0`.

Run : `cd front && npx vitest run src/net/room-client.replication.test.ts`
Attendu : `Tests  12 passed (12)`. Noter les douze lignes `[etape 17b] …` (mesuré à `252ab47` puis
à `44e4e9b` : 0.000 px, 0 perdues partout ; 17 ordres et 128 morts par scénario de latence, 20
ordres et 5 hoquets pour le hoquet, 7 ordres pour les gels, 38 ordres pour le portail).

- [ ] **Étape 2 : contre-épreuve §1.1 (l'ordre du salon)**

Dans `back/src/room.ts`, recouper le bloc `// Etape 17b : APRES les naissances du pas …` →
fin du `if (this.#tick % stepsPerField === 0) { … }` et le recoller juste avant
`// Une vague est un GROUPE d'ordres (principal, escorte) : chacun nait dans`.
Run : `cd front && npx vitest run src/net/room-client.replication.test.ts`
Attendu : **les douze rouges** (mesuré : latences 0 à 3 à 992,653 px, hoquet 3 539,755 px, les
cinq gels 139,536 px, portail 5 566,747 px).
Puis : `git restore back/src/room.ts && git diff --stat` → rien.

- [ ] **Étape 3 : contre-épreuve §1.2 (les ordres du futur)**

Dans `#applyPendingOrders` (`front/src/net/client.ts`), `if (order.spawnTick === tick) {` →
`if (order.spawnTick >= tick) {`.
Run : le banc. Attendu : **latence 0 rouge** (mesuré : 54,634 px), le reste vert.
Puis : `git restore front/src/net/client.ts && git diff --stat` → rien.

- [ ] **Étape 4 : contre-épreuve §1.3 (le journal)**

Dans `#replayTick`, supprimer la boucle `for (const order of this.#spawned) { … }` et son
commentaire.
Run : le banc. Attendu : **latences 1, 2, 3 rouges** (460 perdues chacune), **hoquet rouge**
(1 339,426 px, 5 perdues), **portail latence 2 rouge** (1 830 perdues).
Puis : `git restore front/src/net/client.ts && git diff --stat` → rien.

- [ ] **Étape 5 : contre-épreuve §1.4 (le rejeu exact des vagues en retard)**

Dans `#replayLate`, `} else if (this.#hordeHistory.holds(order.spawnTick - 1)) {` →
`} else if (false && this.#hordeHistory.holds(order.spawnTick - 1)) {` (tout ordre en retard
repasse par le rattrapage approché).
Run : le banc. Attendu : **latences 1, 2, 3 rouges** (mesuré : 1 295,978 / 1 277,403 /
1 235,062 px, 0 / 2 / 3 perdues), **portail latence 2 rouge** (5 566,784 px).
Puis : `git restore front/src/net/client.ts && git diff --stat` → rien.

- [ ] **Étape 6 : contre-épreuve §1.5 (chaque snapshot à son arrivée)**

Dans `#onFrame`, supprimer le bloc `// Etape 17b : CHAQUE snapshot entre a l'historique …`
jusqu'au `);` de `this.#history.record(…)` (la ligne `const presents = …` comprise). Dans
`#advanceHorde`, remplacer les deux lignes

```ts
    // L'historique des joueurs s'enregistre a la reception (`#onFrame`).
    const snapshot = this.#buffer.latest();
```

par l'ancien enregistrement du seul dernier snapshot (filtre de l'étape 18 compris) :

```ts
    const snapshot = this.#buffer.latest();
    if (snapshot) {
      const vivants = snapshot.players.filter((p) => p.hp > 0 && !this.#absent.has(p.id));
      this.#history.record(snapshot.tick, vivants.map((p) => p.x), vivants.map((p) => p.y), vivants.map((p) => p.id));
    }
```

Run : le banc. Attendu : **hoquet rouge** (mesuré : 1 064,738 px), le reste vert.
Puis : `git restore front/src/net/client.ts && git diff --stat` → rien.

- [ ] **Étape 7 : contre-épreuve §1.6 (l'historique pendant le gel)**

Dans `Room#step`, supprimer les trois `this.#recordHistory();` qui précèdent les `return` gelés
(portail, étalage, gel) — garder celui de fin de pas.
Run : le banc. Attendu : **les cinq gels d'étalage rouges** (mesuré : départ 73,886 px, arrivée
7,892 px, leurre 64,664 px — les chiffres de la spec §1.6 — absence et resync 73,886 px), le
reste vert.
Puis : `git restore back/src/room.ts && git diff --stat` → rien.

- [ ] **Étape 8 : rien n'a bougé**

Run : `git status --short`
Attendu : vide. Noter les six contre-épreuves (scénarios rouges, chiffres) pour le bilan. Pas de
commit.

---

### Tâche 6 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-11-07-etape-17b-resultats.md`
- Modifier : `README.md` (une ligne entre celle de l'étape 17, l.40, et celle de l'étape 18,
  l.41 — la ligne 18 existe déjà)

**Interfaces :**
- Consomme : les tâches 1 à 5.
- Produit : le portique vert, le coût du rejeu mesuré, le bilan ouvert, le README à jour, le graphe
  rafraîchi.

- [ ] **Étape 1 : le portique complet, rien d'autre en vol**

Run : `npm run lint && npm run typecheck && npm test`
Attendu : tout vert. Noter le nombre de tests front et back **de cette exécution seule** (à
`44e4e9b` : front 916, back 1769). C'est la première fois que `back/src/server.test.ts` et les
`*.integration.test.ts` — dont `reconnexion.integration.test.ts` de l'étape 18 — tournent avec le
nouvel ordre de `Room#step` et l'historique pendant le gel (tâche 2) : un échec isolé de compte ou
d'or à 0 se relance **une fois** (base partagée) ; un écart de position ou de tick, non.

- [ ] **Étape 2 : les bancs, et le coût du rejeu à 4 000 entités**

Run : `npm run bench`
Noter `bench:sim`, `bench:net`, et dans `bench:sep` (`back/bench/steering.bench.ts`) la colonne
`pas (ms)` de la ligne `entites = 4000`, pour chaque formation. C'est le coût d'un `Horde.step`,
celui que `#replayTick` paie par tick rejoué.

Le coût d'une image qui rejoue : `(1 + n) × pas(4000)`, le pas courant plus `n` ticks rejoués.
Pour une vague en retard de `L` ticks, `#replayLate` repart de `spawnTick − 1` : `n = L + 1` ;
pour une mort de `L` ticks, `n = L` ; au pire (l'anneau entier), `n = ROLLBACK_DEPTH_TICKS − 1 = 7`.
Noter au bilan le tableau `L = 1, 2, 3` et le pire, en ms, contre le budget d'une image à 60 Hz
(16,7 ms). Avant l'étape 17b, une mort en retard coûtait déjà `(1 + L) × pas` ; une vague en retard
ne coûtait qu'un rattrapage de ses seules entités.

Si le pire dépasse 16,7 ms à 4 000 entités, ajouter en tête du docbloc de `#replayLate`
(`front/src/net/client.ts`) la ligne
`ponytail: un rejeu de 8 pas coute <mesure> ms a 4 000 entites (bench:sep) ; prochain levier :
ne rejouer que jusqu'au tick courant du serveur.` (spec §4), avec la mesure, et la commiter avec
le bilan.

- [ ] **Étape 3 : le graphe**

Run : `graphify update .`

- [ ] **Étape 4 : le bilan**

`docs/plans/2026-11-07-etape-17b-resultats.md`, sur le modèle de
`docs/plans/2026-11-06-etape-17-resultats.md` — titre « Étape 17b — la synchro exacte :
résultats », liens **Spec** et **Plan**, un paragraphe d'ouverture (la horde du client rejoint
celle du serveur à 0,000 px de la latence 0 à 3, aucun octet de plus), puis
« ⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur. » :

1. **Le livrable** — le banc `front/src/net/room-client.replication.test.ts`, ses douze scénarios
   avant (tableau de la tâche 1, étape 3) et après (tâche 5, étape 1), et les six contre-épreuves
   (tâche 5, étapes 2 à 7) en un tableau correctif / scénarios rouges / chiffre.
2. **Ce qui est livré** — un tableau pièce / où : l'ordre naissance → rafraîchissement et
   `#recordHistory()` (`back/src/room.ts`) ; l'historique à la réception, les ordres du futur, le
   journal `#spawned`, `#replayLate`, `lateOrders`, `hordeAt`, la remise à neuf au `RESYNC`
   (`front/src/net/client.ts`) ;
   `holds` / `clear` (`shared/horde-history.ts`).
3. **Le coût** — sur le fil : **aucun message nouveau, aucun octet de plus**. Au client : le
   tableau de l'étape 2 (coût d'une image qui rejoue à 4 000 entités, contre 16,7 ms).
4. **Écarts au plan et à la spec** — les douze écarts assumés de ce plan, une ligne chacun (le n° 1
   en premier : le rejeu unique conçu ici, et les gels qui ne rejouent plus à la réception), plus
   ce que l'exécution aura changé. Et une ligne : les « Défauts antérieurs » du bilan de l'étape 17
   sont refermés par cette étape (le document de l'étape 17 n'est pas modifié).
5. **Le portique** — le tableau typecheck / tests front / tests back / lint, les bancs.
6. **Vérification manuelle — ouverte**, les points du §6 de la spec :
   - en coop à deux sur deux machines (ou deux onglets), la horde se voit-elle au même endroit des
     deux côtés au fil d'une longue run ?
   - les petits d'un diviseur apparaissent-ils toujours chez les deux joueurs ?
   - un porteur de coffre ou une proie qui vient de naître réagit-il tout de suite ?

   Plus le §7 de la spec pour l'étape 18, déjà passée : `#recordHistory()` existe, le `RESYNC`
   d'un salon gelé porte les lignes des ticks gelés (assertion de la tâche 2), et le banc mesure
   l'absence et le rechargement pendant un gel à 0,000 px. Et un point à jouer : couper le Wi-Fi
   d'un joueur pendant un étalage, revenir avant la fin — la horde ne saute pas au dégel.

- [ ] **Étape 5 : le README**

Entre la ligne de l'étape 17 (`README.md` l.40) et celle de l'étape 18 (l.41), insérer :

```markdown
| 17b | La synchro exacte : la horde du client rejoint celle du serveur, 0,000 px de la latence 0 à 3 — **zéro octet de plus** | 📝 — [spec](docs/specs/2026-11-07-etape-17b-synchro-exacte.md) · [plan](docs/plans/2026-11-07-etape-17b-synchro-exacte.md) · [résultats](docs/plans/2026-11-07-etape-17b-resultats.md) |
```

- [ ] **Étape 6 : commit**

```bash
git add docs/plans/2026-11-07-etape-17b-resultats.md README.md
git commit -m "docs: le bilan de l etape 17b (verification manuelle ouverte)"
```

(Avec `front/src/net/client.ts` si l'étape 2 a posé le `ponytail:`.)

---

## Auto-revue

**Couverture de la spec.**
- §1.1 l'ordre naissance / rafraîchissement → tâche 2 (étapes 3 et 5 : le bloc déplacé, le docbloc
  et l'avertissement faux réécrits) ; le `ponytail:` du client → tâche 4, étape 8 ; le commentaire
  de référence de `client.test.ts` qui recopiait l'ordre du client → tâche 4, étape 10.
- §1.2 les ordres du futur → tâche 3 (étape 3), gardé par la tâche 4 (`#applyPendingOrders` ne
  fait naître que `spawnTick === tick`, `#replayLate` remet en file `spawnTick > tick`).
- §1.3 le journal, élagué au-delà de `ROLLBACK_DEPTH_TICKS`, re-naissance en tête de `#replayTick`
  avant le rafraîchissement, ordre `spawnTick` puis arrivée → tâche 4 (étapes 4, 8), écart n° 2.
- §1.4 toute vague en retard dans l'anneau par rejeu, `#freezeTouches` supprimé, **un seul rejeu**
  depuis le plus ancien tick, rattrapage léger réservé aux ordres trop vieux et compté → tâche 4
  (étapes 6, 8, 9), écarts n° 1 et 3 ; coût mesuré → tâche 6, étape 2.
- §1.5 chaque snapshot à son arrivée → tâche 3 (étape 4).
- §1.6 `#recordHistory()` et les trois retours gelés, pas `#runOver` → tâche 2 (étape 4).
- §2 → contraintes globales.
- §3 le banc et ses quatre familles de scénarios → tâche 1 (écarts n° 5 à 7, 11) ; rouge aujourd'hui →
  tâche 1, étape 3 ; chaque correctif en fait passer → bascules des tâches 2, 3, 4 (écart n° 8) ;
  contre-épreuves → tâche 5 ; tests unitaires : ordre du pas et dégel (`room.test.ts`, tâche 2),
  ordre du futur et deux snapshots (tâche 3), petit et mort du parent, un seul rejeu ordre + mort
  (tâche 4) ; le test « pas de rejeu pour une vague ordinaire » inversé (tâche 4, étape 1).
- §4 risques : coût (tâche 6, étape 2, `ponytail:` conditionnel) ; ordre des naissances (journal
  trié, vérifié par le banc) ; ordre trop vieux compté (`lateOrders`, test tâche 4).
- §5 portique et coût → tâche 6 ; §6 vérification manuelle → bilan ; §7 effet sur l'étape 18 —
  passée avant ce plan : la réconciliation en tête, l'historique du `RESYNC` pendant le gel
  (tâche 2), le même jeu d'absents à la réception (tâche 3), la remise à neuf au `RESYNC`
  (tâche 4, écart n° 12), les variantes `absence` et `resync` du banc (tâche 1).

**Espaces réservés.** Aucun « TBD ». Seule valeur à remplir à l'exécution : la mesure de
`bench:sep` dans le `ponytail:` conditionnel de la tâche 6 — une mesure, pas une décision. Les
tests existants modifiés sont cités par titre et par ligne ; les blocs remplacés, par leurs
textes de début et de fin.

**Cohérence des noms.** `hordeAt(tick, into)` (tâche 1, lu par le banc et par le test « croise le
début d'un gel ») ; `#recordHistory()` (tâche 2, nommé par l'étape 18) ; `#spawned`,
`#journal(order, tick)`, `#replayLate(tick, dt)`, `#freezeReplayFrom`, `NO_REPLAY`, `lateOrders`,
`HordeHistory#holds` / `#clear` (tâche 4, cités par les contre-épreuves de la tâche 5 et par
`#onResync`) ;
`LATENCE` / `latence`, `PORTAIL` / `portail` (tâche 1, basculés par les tâches 2 à 4).

**Points de vigilance.** Les six lignes ont chacune leur test dans la tâche qui possède le code :
ordre du futur (tâche 3), ordre et mort à des ticks différents dans les deux sens (tâche 4), rejeu
qui croise un gel (tâche 4), ordre plus vieux que l'anneau (tâche 4), deux snapshots pendant un
gel (tâche 3), `RESYNC` sur un client en avance (tâche 4). Tous rouges avant leur correctif,
mesuré (à `44e4e9b` pour les six).
