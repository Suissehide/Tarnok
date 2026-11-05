# Étape 17 — l'extraction, retravaillée : un portail qui gèle, une carte compacte

**Statut :** validée en conversation le 6 novembre (forme : « carte compacte centrée »).
**Remplace :** le §6 de [l'étape 6a](2026-09-01-etape-6a-paliers.md) sur un point, le gel ;
la règle du vote (majorité, égalité = on continue, abstention non comptée, vote révocable,
multiplicateur `+ EXTRACT_MULTIPLIER_STEP`) ne change pas.

## 0. Pourquoi

Retour de jeu de Léo : « ça prend de la place, ça met pas en pause, le fonctionnement actuel est
pas pratique ». Aujourd'hui le portail ouvre un bandeau de 1 100 px en bas de l'écran (titre,
deux lignes d'enjeu en toutes lettres, deux boutons, les votants) pendant 20 s **où le monde
continue de tourner** : il faut lire, négocier et cliquer en pleine horde. L'étape 6a voulait que
« le temps soit l'enjeu » ; à l'usage, c'est surtout une gêne.

Objectif : décider vite, à l'abri, et sans que l'écran soit mangé.

## 1. Le gel

Le portail **gèle le monde**, exactement comme l'étalage :

- **Serveur** (`back/src/room.ts`, `step`) : juste après le garde `#runOver`, **avant** l'ouverture
  d'un étalage dû :

  ```ts
  if (this.portalOpen) {
    this.#stepPortal();
    return;
  }
  ```

  L'appel à `#stepPortal()` en fin de `step` disparaît. Le tick continue d'avancer (il date le
  verdict), rien d'autre ne bouge : ni joueurs, ni horde, ni tirs, ni contact, ni ramassages, ni
  minuteur d'événement, ni directeur de vagues.
- Le portail s'ouvre toujours dans le pas du tick `T` (à l'endroit actuel, après les ordres de
  vague). Le monde a tourné pendant `T` ; **le premier tick gelé est `T + 1`**. `deadlineTick`
  vaut toujours `T + PORTAL_WINDOW_TICKS`.
- **Verdict « rester »** à un tick `C` : `#freezeUntilTick = C`,
  `#resumeEndTick = C + LEVEL_RESUME_TICKS` — la même reprise progressive qu'après un étalage.
  **Verdict « partir »** : la run se termine, comme aujourd'hui.
- **Fermeture** inchangée : dès que tous les participants ont voté (donc au premier clic en
  solo), ou à l'échéance (`PORTAL_WINDOW_TICKS` = 600, 20 s, qui devient un **plafond** et non
  plus l'enjeu). À l'échéance, majorité stricte de « partir », sinon on continue.

**Aucun octet de plus, aucun message nouveau.** Le client connaît déjà les deux bornes :

- **début** : `PORTAL_OPEN.deadlineTick − PORTAL_WINDOW_TICKS + 1` ;
- **fin** : `PORTAL_RESULT.effectTick`.

**Client** (`front/src/net/client.ts`) : à `PORTAL_OPEN`, `#freezeStartTick` prend le début
ci-dessus et `#freezeUntilTick` / `#resumeEndTick` passent à `Number.MAX_SAFE_INTEGER` (même
traitement que `LEVEL_UP`) ; à `PORTAL_RESULT`, `#freezeUntilTick = effectTick` et
`#resumeEndTick = effectTick + LEVEL_RESUME_TICKS` (même traitement que `DRAFT_RESULT`). Le
rejeu existant absorbe un `PORTAL_OPEN` reçu après le début du gel, comme il absorbe un
`LEVEL_UP` tardif. `isFrozen` devient vrai pendant le portail : la roue de ping s'y ferme d'elle-
même (`canOpen`).

## 2. Portail et étalage ne se chevauchent jamais

- **Un étalage ouvert** gèle le monde, donc aucune vague ne sort et aucun portail ne s'ouvre.
  Rien à écrire.
- **Un étalage dû** (niveau, coffre, événement) pendant le portail **attend le verdict** : le
  garde du portail précède l'ouverture d'étalage dans `step`. Il s'ouvre au premier pas qui suit
  un verdict « rester ».
- **Verdict « partir »** : les étalages dus sont abandonnés avec la run.

## 3. La carte

Remplace le bandeau (`front/index.html` `#portal-layer`, `front/src/ui/portal.ts`,
`front/src/styles/main.css`).

```
┌──────────── Portail ─── 14 s ┐
│  ┌────────────┐ ┌────────────┐ │
│  │ PARTIR [1] │ │ RESTER [2] │ │
│  │  1 250 or  │ │  1 560 or  │ │
│  │            │ │ si l'équipe│ │
│  │            │ │    tient   │ │
│  └────────────┘ └────────────┘ │
│      ● part  ● reste  ○ …      │
└────────────────────────────────┘
```

- **Centrée**, environ **520 px** de large dans le canevas UI, sur un voile léger comme
  l'étalage. Le voile ne capte pas le pointeur hors de la carte.
- **Titre** : « Portail » et le chronomètre en secondes, dérivé du tick comme aujourd'hui
  (`remainingSeconds`). Après le verdict, le titre dit le verdict (« L'équipe part — 1 250 or » /
  « L'équipe reste ») jusqu'à la disparition de la carte (`#portalCloseTick`, inchangé).
- **Deux boutons**, un chiffre chacun :
  - **Partir `[1]`** : `formatGold(leaveGold(gold, m))` or ;
  - **Rester `[2]`** : `formatGold(stayGold(gold, m))` or, et en petit « si l'équipe tient ».
  Le multiplicateur n'est plus affiché en toutes lettres. Le bouton de son propre vote est mis en
  avant (`data-mine`, existant).
- **Touches `1` et `2`** (`e.code` `Digit1` / `Digit2` et pavé numérique `Numpad1` /
  `Numpad2`) : votent « partir » / « rester » tant que la carte est ouverte et non tranchée, que
  le menu Échap est fermé et le bilan caché. Rappuyer sur la touche de son vote actuel **retire**
  le vote (`NO_VOTE`), comme un second clic sur le même bouton.
- **Les votants** : une rangée de pastilles à la couleur du joueur (`playerColor`), trois états
  distincts — part, reste, **pas encore voté** (l'abstention ne se confond jamais avec
  « reste », règle de l'étape 6a). Pas de libellé long.
- `stakeLines` disparaît ; `leaveGold`, `stayGold`, `formatGold`, `voteState` restent.
- Un joueur mort voit et utilise la carte comme les autres (inchangé).

## 4. Ce qui ne change pas

- La règle du vote (`back/src/portal.ts`), `PORTAL_EVERY_WAVES` = 20, `PORTAL_WINDOW_TICKS` =
  600, `EXTRACT_MULTIPLIER_STEP`, `extractGold`, le crédit d'or au `RUN_OVER`.
- Le format des messages `PORTAL_OPEN`, `VOTES`, `PORTAL_RESULT`, `VOTE`.
- Les commentaires qui disent « le vote ne gèle rien » / « le monde continue de tourner »
  (`back/src/portal.ts`, `shared/constants.ts` `PORTAL_WINDOW_TICKS`, `back/src/room.ts`,
  `back/src/server.ts`, `front/index.html`, `front/src/ui/portal.ts`) sont **réécrits**, pas
  laissés faux.

## 5. Tests

- **Salon** (`back/src/room.test.ts`) :
  - pendant un portail ouvert, positions des joueurs, horde, `#tick` du directeur, minuteur
    d'événement et or ne bougent pas, sur plusieurs ticks ;
  - en solo, un vote ferme le portail au tick suivant ; « rester » rend le monde après
    `LEVEL_RESUME_TICKS` de reprise ;
  - un niveau dû pendant le portail n'ouvre son étalage qu'après le verdict « rester » ;
  - « partir » termine la run sans ouvrir l'étalage dû.
- **Réplication** (`shared/horde.replication.test.ts` ou `front/src/net/client.test.ts`) : un
  portail traversé, `PORTAL_OPEN` reçu en retard — dérive de la horde **0,000 px** avec rejeu.
- **Client** : `PORTAL_OPEN` fige à `deadlineTick − PORTAL_WINDOW_TICKS + 1`, `PORTAL_RESULT`
  rend la main à `effectTick` avec reprise ; `isFrozen` vrai pendant le portail.
- **Écran** (`front/src/ui/portal.test.ts`) : les deux montants, les trois états de pastille,
  le titre après verdict ; touches `1` / `2` (vote, puis retrait sur la même touche), inertes
  menu Échap ouvert ou carte tranchée.
- **Livrable** (`back/src/portal.integration.test.ts`, vraies sockets) : deux joueurs, un
  portail s'ouvre, les `SNAPSHOT` montrent un monde immobile, un vote « rester » de chacun ferme
  le portail avant l'échéance et le monde repart ; contre-épreuve : sans le garde du portail dans
  `step`, le test rougit.

## 6. Risques

- **Un joueur qui rejoint pendant le portail** ne reçoit pas `PORTAL_OPEN` et ne sait pas que le
  monde est gelé jusqu'au `PORTAL_RESULT` : même lacune qu'un étalage en cours aujourd'hui, hors
  périmètre.
- **Un joueur absent bloque l'équipe jusqu'à 20 s**, comme un étalage. Si c'est trop long en
  jeu, baisser `PORTAL_WINDOW_TICKS` est un réglage d'une ligne.
- Le portail n'est plus une source de tension : si ça manque, ce sera un sujet de design séparé.

## 7. Vérification manuelle

- la carte se lit-elle d'un coup d'œil, sans masquer le jeu au point de perdre le fil ?
- 1 / 2 au clavier : naturel, ou en conflit avec un autre geste ?
- la reprise après « rester » est-elle confortable ?
