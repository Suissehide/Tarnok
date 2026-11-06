# Étape 17 — l'extraction qui gèle : plan d'implémentation

> **Pour les agents :** sous-skill requis : superpowers:subagent-driven-development (recommandé) ou
> superpowers:executing-plans, tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** le portail d'extraction **gèle le monde** comme l'étalage, et le bandeau de 1 100 px
devient une **carte compacte centrée** (deux boutons, un montant chacun, des pastilles de votants),
pilotable aux touches `1` et `2`.

**Architecture :** au serveur, un garde de quatre lignes dans `Room#step`, juste après celui de fin
de run et **avant** l'ouverture d'un étalage dû : portail ouvert → `#stepPortal()` puis `return`.
Le verdict « rester » pose la même reprise progressive qu'un étalage (`#freezeUntilTick`,
`#resumeEndTick`). Au client, `PORTAL_OPEN` et `PORTAL_RESULT` passent par **les mêmes deux
aides** que `LEVEL_UP` et `DRAFT_RESULT` (`#freezeFrom`, `#thawAt`) ; ces aides datent enfin le gel
au tick (les ticks d'avant le début lisent les bornes du gel précédent) et **rejouent** les ticks
déjà simulés quand le message arrive en retard (écart n° 1). L'écran devient une carte de 520 px
sur un voile léger qui ne capte pas le pointeur ; `1` / `2` passent par une fonction pure
(`portalKeyChoice`) et une méthode publique (`PortalScreen#vote`).

**Pile :** TypeScript, `ws`, Fastify, Pixi.js v8, Vitest (jsdom côté front pour l'UI), Biome,
Prisma/Postgres pour les tests qui ouvrent de vraies sockets.

**Spec :** [`docs/specs/2026-11-06-etape-17-extraction.md`](../specs/2026-11-06-etape-17-extraction.md)

**Où l'on travaille :** dans le worktree `../Tarnok-extraction`, sur la branche
`etape-17-extraction`, déjà créée depuis `main` à `3c1b007` (la spec, puis la passe interfaces).

```bash
cd ../Tarnok-extraction && npm ci && npm run db:generate -w back
cp ../Tarnok/back/.env back/.env && cp ../Tarnok/front/.env front/.env
```

Tous les chemins de ce plan sont relatifs à la racine du worktree. Les ancres `l.N` sont celles
du commit `3c1b007`.

## Réconciliation avec la passe interfaces (3c1b007)

Le plan a été écrit contre `5c4a0e0` ; une autre session a commité depuis `ec8900b`, `32c789f`,
`18b0999`, `7e4f8ab`, `3c1b007`. Ce qui a changé ici, une ligne chacun :

- **Ancres recalées** partout (room.ts, server.ts, client.ts, main.ts, index.html, main.css) ;
  `room.test.ts` (l.4847-4887, `});` du `describe` l.5049), `portal.integration.test.ts`,
  `portal.test.ts`, `hud.ts`, `hud.test.ts`, `ui/draft.ts`, `shared/constants.ts`,
  `back/src/portal.ts` (doc l.6-26) n'ont pas bougé là où le plan les touche.
- **Fin de `step` (tâche 1)** : `room.ts` l.1890-1911 enregistre désormais l'historique des vivants
  **après** `#stepPortal()` ; le remplacement ne retire que l'appel et son commentaire
  (l.1880-1887) et **garde** ce bloc. Le garde de tête rend la main avant lui, comme le gel d'un
  étalage (l.1399) : pas d'historique serveur pendant le vote, exactement comme pendant un étalage.
- **Verbes (tâche 1, tranché)** : `useAbility` refuse désormais pendant un étalage et le gel
  (`room.ts` l.1314-1318, test `verbes.test.ts` l.309-326), mais pas pendant le portail, que
  `#freezeUntilTick` ne couvre pas. Le garde gagne `this.portalOpen`, et un huitième test
  (« un verbe est refusé pendant le vote ») le tient — sinon un Relais téléporterait dans un
  monde gelé. Le constat « hors périmètre » du bilan (tâche 6) est mis à jour en conséquence.
- **`Portal#forget`** (`back/src/portal.ts` l.95-99, appelé par `Room#leave` l.1262) : déjà fait,
  conservé, non réécrit. Avec le garde de tête, `#stepPortal` tourne chaque pas : un parti qui
  quitte pendant le vote ferme le portail dès que les présents ont voté.
- **Morts** (`18b0999`) : un mort ne bouge plus (`room.ts` l.1414-1417, `client.ts` `#localSpeed`
  l.2364-2367), n'est plus une cible ni ancré dans l'historique (`client.ts` l.2751-2761) ;
  `Draft.open` n'attend que les vivants. Rien à changer : `Portal` attend toujours tous les
  connectés, et le test « un MORT vote pendant le gel » reste juste.
- **Le gel client (tâche 2) n'a pas été touché** par la passe : `LEVEL_UP` / `DRAFT_RESULT` /
  `#movementScale` / les trois gardes sont identiques à `5c4a0e0` (l.2533-2535, l.2593-2594,
  l.3777-3783, l.2768, l.2806, l.3762). La tâche 2 s'applique telle quelle, ancres recalées ;
  aucun chevauchement à arbitrer.
- **Apostrophes typographiques** (`7e4f8ab`, `front/src/ui/portal.ts` l.90, l.141, l.285-286) :
  les textes affichés de la nouvelle carte et leurs tests passent à `’` (« si l’équipe tient »,
  « L’équipe part — … », « L’équipe reste »).
- **`inert`** (`main.ts` l.483-484 `setPaused`, l.499-501 au `RUN_OVER`) : la tâche 3 ajoute
  `el('portal-layer').toggleAttribute('inert', value)` dans `setPaused` — la carte devient
  cliquable (`pointer-events-auto`) et atteignable à Tab, le voile du menu Échap (z-30) ne
  l'arrête qu'à la souris. Le `RUN_OVER` le pose déjà, rien à ajouter.
- **Bandeau du portail élargi à 1 000 px et bloc ÉCHAP décalé** (`index.html` l.597, l.544) :
  rendu caduc par la carte centrée de la tâche 3 ; le bloc ÉCHAP reste où la passe l'a mis.
  `aria-live="polite"` sur `#portal-status` (l.599) est déjà dans le HTML de la tâche 3.
- **Échap ferme les menus** (`main.ts` l.189-206, écran d'accueil seulement) et **H ignore
  Ctrl/Cmd/Alt** (l.613-622) : aucune interaction avec `1` / `2` ; `paused`, `hud`, `summary`
  que lit la tâche 4 existent toujours (l.478, écouteur `keydown` de `join` l.591).
- **Bilan de la passe, §3 point 6** (« Extraction réussie + 0 » quand effacement et « partir »
  tombent au même tick, `#checkRunOver` puis `#stepPortal`) : **refermé par la tâche 1**, puisque
  le vote ne tourne plus qu'à monde gelé. Le bilan de l'étape 17 le dit.
- `--color-slate-soft` est passé à `#c0c6ce` (`main.css` l.26) : la note « si l’équipe tient »
  qui l'emploie sera plus claire ; rien à changer.

## Contraintes globales

- **Aucun message nouveau, aucun octet de plus.** Les formats de `PORTAL_OPEN`, `VOTES`,
  `PORTAL_RESULT` et `VOTE` (`shared/protocol.ts`) ne changent pas ; `shared/protocol.ts` n'est pas
  touché. Le client déduit le début du gel de `PORTAL_OPEN.deadlineTick − PORTAL_WINDOW_TICKS + 1`
  et sa fin de `PORTAL_RESULT.effectTick`.
- Constantes **inchangées**, jamais un nombre en dur ailleurs : `PORTAL_WINDOW_TICKS = 600`
  (devient un plafond, plus l'enjeu), `PORTAL_EVERY_WAVES = 20`, `EXTRACT_MULTIPLIER_STEP`,
  `LEVEL_RESUME_TICKS = 30`, `ROLLBACK_DEPTH_TICKS = 8`.
- **La règle du vote ne change pas** : `back/src/portal.ts` ne change que dans son commentaire de
  classe (majorité stricte de « partir », égalité = on continue, abstention non comptée, vote
  révocable, fermeture dès que tous ont voté ou à l'échéance). `extractGold`, le crédit d'or au
  `RUN_OVER`, le multiplicateur `+ EXTRACT_MULTIPLIER_STEP` : intacts.
- **Jamais toucher `sampleDirection`** (`shared/flowfield.ts`) : elle déplace toute la horde, des
  deux côtés.
- Les commentaires qui disent « le vote ne gèle rien » / « le monde continue de tourner » sont
  **réécrits**, jamais laissés faux : `back/src/portal.ts` (tableau de la classe), `shared/constants.ts`
  (`PORTAL_WINDOW_TICKS`), `back/src/room.ts` (getter `portalOpen`, bloc des vagues, fin de
  `step`), `back/src/server.ts` (l.555-559), `front/index.html` (commentaire de `#portal-layer`),
  `front/src/ui/portal.ts` (doc de classe), `front/src/main.ts` (l.656-657).
- Commentaires de code en français **sans accents** ; textes affichés avec leurs accents ;
  messages de commit conventionnels en français sans accents, sujet en minuscules
  (`feat(back): ...`, `test(front): ...`, `docs: ...`).
- **Discipline des sous-agents** : un sous-agent ne lance **que les fichiers de test de sa tâche**,
  **au premier plan** (`npx vitest run <fichier>`) — jamais `npm test`, jamais un banc, jamais une
  commande en arrière-plan. Le portique complet et les bancs sont au contrôleur, **seul**, à la
  dernière tâche.
- Commandes de test : tests du back depuis `back/` (`cd back && npx vitest run src/...`), tests du
  front depuis `front/` (`cd front && npx vitest run src/...`).
- **Postgres local.** `back/src/portal.integration.test.ts`, `credit.integration.test.ts`,
  `or-survit.integration.test.ts` et `server.test.ts` ouvrent de vraies sockets et créent des
  comptes sur une base **possiblement partagée** avec une autre session (`deleteMany` en
  `beforeEach`) : un échec isolé de compte ou d'or à 0 (`createAccount`, jeton refusé, `WELCOME`
  absent, crédit à 0) se **relance une fois** avant d'en conclure quoi que ce soit.
- Avant chaque commit : `npx biome check --write <fichiers de la tâche>`.
- **Des commits NOUVEAUX seulement** : jamais `--amend`, `rebase`, `reset`, `stash`, ni `checkout`
  d'un autre commit.
- Jamais `pkill -f` : les serveurs de dev de Léo tournent sur 5173 et 3100.
- Dépôt public, actifs sous licence Tiny Swords sur MinIO : **aucun actif nouveau** (la carte
  réutilise `k k-paperx`, `btn btn--tab`, `btn--red`, `veil`).

**Écart assumé n° 1 — le client ne date PAS son gel, et aucun rejeu n'absorbe un gel tardif.**
La spec (§1) écrit : « le rejeu existant absorbe un `PORTAL_OPEN` reçu après le début du gel, comme
il absorbe un `LEVEL_UP` tardif ». Vérifié faux, deux fois :

- **Gel appliqué à la réception.** `LEVEL_UP` (`front/src/net/client.ts` l.2533-2535) pose
  `#freezeUntilTick = #resumeEndTick = MAX` tout de suite, et `#movementScale` (l.3777-3783) comme
  les gardes du champ (l.2768, l.2806, l.3762) ne lisent jamais `#freezeStartTick` : tout tick
  simulé après la réception est gelé, même avant le début daté. Mesuré :
  `cd front && npx vitest run src/net/client.test.ts -t "gel est date"` imprime
  `avant=53.3px` — la horde s'arrête au tick 20 (réception) au lieu du tick 200 (date) ; le seuil
  du test (`> 50`) le laisse passer. Pour le portail c'est le cas **ordinaire** : `PORTAL_OPEN`
  part avec le `SNAPSHOT` de `T` (`back/src/server.ts` l.555-566), et la horde du client, calée sur
  le dernier snapshot (`HORDE_TICK_LAG_TOLERANCE = 1`, l.221 et l.2647), n'a souvent pas encore
  simulé `T` (voire `T − 1`), que le serveur a fait tourner.
- **Aucun rejeu sur un gel.** Les rejeux n'existent que pour les morts, zones, charges et leurres
  (`#applyDeaths` l.3623, `#applyZone` l.3504, `#applyBossCharge` l.3560, `#applyDecoy` l.3725) ;
  `LEVEL_UP` et `DRAFT_RESULT` n'en déclenchent aucun. Aucun test de dérive ne couvre un gel tardif
  (`grep LEVEL_UP shared/horde.replication.test.ts` : rien).

D'où, à la tâche 2, la racine corrigée **une fois**, là où passent les quatre messages : deux aides
`#freezeFrom(startTick, portal)` / `#thawAt(endTick)` qu'empruntent `LEVEL_UP`, `DRAFT_RESULT`,
`PORTAL_OPEN` et `PORTAL_RESULT` ; les bornes du gel précédent gardées pour les ticks d'avant le
début (`#untilAt`) ; et `#replayFrom(fromTick)`, le rejeu depuis l'anneau (`HordeHistory`) quand la
horde a déjà dépassé la borne qui arrive. Effet de bord voulu : `LEVEL_UP` et `DRAFT_RESULT` en
profitent aussi (le test « gel est date » passe de 53 à ~480 px avant le gel, sans changer).

**Écart assumé n° 2 — `isFrozen` vrai pendant le portail réveille l'étalage précédent.**
`front/src/ui/draft.ts` l.409 : `visible = spread.length > 0 && (!draftSettled || isFrozen)`, et
`#draftCards` survit à sa fermeture jusqu'au `DRAFT_OPEN` suivant (`client.ts` l.2585-2591). Sans
rien faire, les cartes du dernier étalage réapparaîtraient sous le portail. `PORTAL_OPEN` vide donc
`#draftCards` (aucun étalage n'est ouvert à ce moment : un étalage gèle le monde, aucune vague ne
sort). La spec ne cite que la roue de ping parmi les lecteurs d'`isFrozen`.

**Écart assumé n° 3 — le badge de gel du HUD dirait « Niveau supérieur — pause… ».**
`front/src/ui/hud.ts` l.291-296 montre le badge dès `frozen` et choisit son texte sur
`draftIsChest` / `draftIsEvent`. Le client expose `freezeIsPortal` (posé par `#freezeFrom`), et le
badge dit « Portail — pause… » pendant le vote et sa rampe.

**Écart assumé n° 4 — « partir » ne dégèle pas le client.** La spec dit qu'à `PORTAL_RESULT`
`#freezeUntilTick = effectTick` sans distinguer le verdict. Au salon, « partir » termine la run
(`#endRun`, `back/src/room.ts` l.2764) et ne pose aucune reprise : le client fait de même et ne
dégèle que sur `VOTE_CHOICE.STAY`.

**Écart assumé n° 5 — le garde des vagues `&& !this.portalOpen` disparaît.** `back/src/room.ts`
l.1571 : depuis le garde de tête, aucune vague ne sort pendant un vote ; la condition est morte.

**Écart assumé n° 6 — trois tests existants changent de sens** (tous trois disaient « le monde
tourne pendant le vote ») :
- `back/src/room.test.ts` l.4847-4887, « LE MONDE NE S ARRETE PAS : la horde avance et le joueur
  bouge pendant le vote » → réécrit en « LE MONDE GELE pendant le vote… » ;
- `back/src/portal.integration.test.ts` l.593-875, la phase 3 (l.647-711) de « l egalite continue,
  puis la majorite fait partir avec l or MAJORE » → ses assertions s'inversent (horde et joueurs
  immobiles) ; `SEUIL_JOUEUR_PX` / `SEUIL_HORDE_PX` (l.81-91) disparaissent ;
- `back/src/portal.integration.test.ts` l.885-964, « l effacement de l equipe efface l or, sur le
  fil » → l'effacement pendant le vote n'existe plus : les quatre votent « rester », puis l'équipe
  est effacée ; un verdict au lieu de zéro (l.963).

Vérifiés intacts (ouvrent et votent aussitôt) : `room.test.ts` l.4791, 4799, 4821, 4889, 4931,
4985 ; `server.test.ts` l.455, 590 ; `credit.integration.test.ts` l.546, 579, 601, 640, 690, 737 ;
`or-survit.integration.test.ts` l.372, 414 ; `portal.test.ts` (machine pure). Mesuré avant
changement : `cd back && npx vitest run src/portal.test.ts src/room.test.ts -t portail` → 25 / 25.

**Écart assumé n° 7 — la touche passe par une fonction pure qui reçoit le blocage.**
`front/src/main.ts` n'est pas testable (`main.test.ts` remplace tout `Stage`). Pour que « inerte
menu Échap ouvert » soit tenu par un test, `portalKeyChoice(code, blocked)` reçoit le blocage
(`e.repeat || paused || HUD caché || bilan affiché`) calculé par `main.ts`, et rend `null`.

**Écart assumé n° 8 — `formatMultiplier` disparaît avec `stakeLines`, et l'abstention s'écrit
« … ».** Plus aucun appelant (`grep -rn formatMultiplier front/src` : `ui/portal.ts` seul). La
pastille porte un mot court (« part », « reste », « … ») : « n'a pas voté » est le libellé long que
la spec (§3) retire ; l'état reste distinct par `data-choice` et par le style (pastille creuse).

**Écart assumé n° 9 — `PortalScreen` perd son paramètre `stakes`**, et `#portal-stakes` quitte
`index.html` : il n'y a plus de lignes d'enjeu. Les montants vivent sous chaque bouton
(`[data-gold="leave"]`, `[data-gold="stay"]`).

## Points de vigilance de la revue

1. **Un étalage dû pendant le vote** (coffre et niveau dus au même moment) : rien ne s'ouvre avant
   le verdict ; « rester » à `C` → l'étalage du coffre s'ouvre à `C + 1`, le niveau ensuite →
   test tâche 1.
2. **Un vote qui arrive pendant la rampe de reprise** (après le verdict) : refusé au salon
   (`setVote` rend `false`), aucun second verdict, la run continue ; à l'écran, `vote` est inerte une
   fois tranché → tests tâches 1 et 4.
3. **Le menu Échap ouvert (ou le bilan affiché) pendant qu'on presse `1` / `2`** : aucun `VOTE` ne
   part → test tâche 4.
4. **Un joueur mort vote pendant le gel** : sa voix compte, il reste à 0 PV, la run ne se termine
   pas → test tâche 1.
5. **Un événement en cours pendant le vote** (premier événement et premier portail tombent tous
   deux vers la vague 20, `EVENT_FIRST_WAVE` et `PORTAL_EVERY_WAVES`) : aucun `EVENT_STATE`
   pendant le gel ni la rampe, il repart ensuite → test tâche 1.
6. **Un verbe (Espace) pendant le vote** : `Room#useAbility` agit hors de `step` ; refusé pendant
   le vote et au tick du verdict, comme pendant un étalage depuis la passe interfaces → test
   tâche 1.

---

## Carte des fichiers

| Fichier | Rôle |
| --- | --- |
| `back/src/room.ts` | le garde du portail en tête de `step`, le portail dans le garde de `useAbility`, la reprise après « rester », les commentaires |
| `back/src/portal.ts`, `shared/constants.ts`, `back/src/server.ts` | commentaires réécrits (le vote gèle) |
| `back/src/room.test.ts` | le gel, le vote solo et la rampe, l'étalage qui attend, « partir », les points de vigilance 1, 2, 4, 5, 6 |
| `back/src/portal.integration.test.ts` | deux tests existants inversés (tâche 1), **le livrable** (tâche 5) |
| `front/src/net/client.ts`, `front/src/net/client.test.ts` | `#freezeFrom`, `#thawAt`, `#untilAt`, `#replayFrom`, `freezeIsPortal`, l'étalage vidé ; dérive 0,000 px |
| `front/src/ui/hud.ts`, `front/src/ui/hud.test.ts` | « Portail — pause… » |
| `front/src/ui/portal.ts`, `front/src/ui/portal.test.ts` | la carte ; `portalKeyChoice`, `PortalScreen#vote` |
| `front/index.html`, `front/src/styles/main.css`, `front/src/main.ts` | le voile et la carte, le câblage, les touches |
| `docs/plans/2026-11-06-etape-17-resultats.md` (créé), `README.md` | le bilan |

Pourquoi ce découpage : le **serveur** (1) est le cœur, et il porte les trois tests qui changent
de sens — un relecteur juge le gel et ses conséquences ensemble ; le **client** (2) est une autre
revue (datation, rejeu, dérive) et réunit les trois lecteurs d'`isFrozen` ; la **carte** (3) et les
**touches** (4) peuvent s'accepter l'une sans l'autre ; le **livrable** (5) quand tout est là ; le
**portique** (6) au contrôleur.


---

### Tâche 1 : serveur — le portail gèle le monde

**Fichiers :**
- Modifier : `back/src/room.ts` (garde de `useAbility` l.1314-1318 ; docbloc de `step` l.1340-1374 ;
  garde de tête l.1375-1391 ; bloc des vagues l.1566-1575 ; fin de `step` l.1876-1911 ; getter
  `portalOpen` l.769-772 ; docbloc et verdict de `#stepPortal` l.2745-2777),
  `back/src/portal.ts` (doc de classe l.6-26), `shared/constants.ts` (doc de `PORTAL_WINDOW_TICKS` l.557-566), `back/src/server.ts`
  (commentaire l.555-559)
- Tester : `back/src/room.test.ts` (le test l.4847-4887 réécrit ; huit tests ajoutés à la fin du
  `describe` « le portail s'ouvre toutes les PORTAL_EVERY_WAVES vagues », avant sa `});` l.5049),
  `back/src/portal.integration.test.ts` (en-tête l.32-50 ; constantes l.74-91 ; phase 3 l.647-711 ;
  test l.877-964)

**Interfaces :**
- Consomme : rien.
- Produit : `Room#step` ne fait plus qu'incrémenter le tick et avancer le vote tant que
  `room.portalOpen` ; un verdict « rester » à `C` laisse `C` gelé et pose la rampe `C + 1 …
  C + LEVEL_RESUME_TICKS`. Rien de nouveau sur le fil : `PORTAL_OPEN.deadlineTick = T +
  PORTAL_WINDOW_TICKS` (ouverture dans le pas de `T`), `PORTAL_RESULT.effectTick = C`. Les
  tâches 2 et 5 s'appuient sur ces deux dates.

- [ ] **Étape 1 : réécrire le test qui disait « le monde tourne », et écrire les nouveaux**

`back/src/room.test.ts` : remplacer **tout** le test l.4847-4887
(`it('LE MONDE NE S ARRETE PAS : la horde avance et le joueur bouge pendant le vote', …)`) par :

```ts
  it('LE MONDE GELE pendant le vote : joueur, horde, vagues et or immobiles, le tick compte (etape 17)', () => {
    // ⚠️ **Le test qui rougit sans le garde du portail** en tete de
    // `Room#step`. Le joueur ENVOIE des entrees et un monstre a une cible : un
    // gel partiel (la horde seule, ou les joueurs seuls) se verrait.
    const room = new Room(4242);
    room.join(1);
    room.debugSetGold(240);
    ouvrirLePortail(room);
    expect(room.portalOpen).toBe(true);

    const joueurAvant = room.positionOf(1);
    const p = positionOf(room, 1);
    const suiveur = spawnMonsterAt(room, 8100, p.x + 900, p.y);
    const horde = (): number[] => [
      ...Array.from(room.horde.x.subarray(0, room.horde.count)),
      ...Array.from(room.horde.y.subarray(0, room.horde.count)),
    ];
    const hordeAvant = horde();
    const orAvant = room.gold;
    const tickAvant = room.tick;
    let vagues = 0;

    // Sept secondes : plus qu'une periode de vague (6 s), le directeur en
    // sortirait une si le monde tournait.
    for (let t = 0; t < 7 * TICK_HZ; t++) {
      room.applyInput(1, 20_000 + room.tick, 127, 0);
      room.step(DT);
      vagues += room.drainWaveOrders().length;
    }

    // Le vote court toujours, et le tick a compte chaque pas : c'est lui qui
    // date le verdict.
    expect(room.portalOpen).toBe(true);
    expect(room.tick).toBe(tickAvant + 7 * TICK_HZ);
    // ⚠️ **Les DEUX moities du monde** : le joueur qui veut marcher, la horde
    // qui a une cible.
    expect(room.positionOf(1)).toEqual(joueurAvant);
    expect(room.horde.slotOf(suiveur)).toBeGreaterThanOrEqual(0);
    expect(horde()).toEqual(hordeAvant);
    expect(vagues).toBe(0);
    expect(room.gold).toBe(orAvant);
  }, 60_000);
```

À la fin du même `describe` (après le test « un joueur MORT vote, et sa voix fait BASCULER le
verdict », avant la `});` qui ferme le `describe`, l.5049), ajouter :

```ts
  it('etape 17 : en solo, un vote ferme le portail au tick suivant ; RESTER rend le monde par la rampe', () => {
    const room = new Room(4242);
    room.join(1);
    ouvrirLePortail(room);
    room.drainPortalOpens();
    const avant = room.positionOf(1);
    if (!avant) {
      throw new Error('le joueur 1 doit etre dans le salon');
    }

    expect(room.setVote(1, VOTE_CHOICE.STAY)).toBe(true);
    // Le joueur veut marcher a droite des maintenant : seul le gel le retient.
    room.applyInput(1, 20_000 + room.tick, 127, 0);
    pas(room);
    const verdict = room.tick;
    expect(room.portalOpen).toBe(false);
    expect(room.drainPortalResults()).toEqual([
      { effectTick: verdict, decision: VOTE_CHOICE.STAY, gold: room.gold },
    ]);
    // Le tick du verdict est encore gele : `#freezeUntilTick = C`, comme a la
    // fermeture d'un etalage.
    expect(room.positionOf(1)).toEqual(avant);

    // C + 1, puis C + 2 : un, puis deux trentiemes d'un pas plein — la meme
    // rampe qu'apres un etalage (`#movementScale`). Le rapport, pas la vitesse :
    // les bonus de classe ou de compte n'y changent rien.
    pas(room);
    const x1 = room.positionOf(1)?.x ?? 0;
    pas(room);
    const x2 = room.positionOf(1)?.x ?? 0;
    expect(x1 - avant.x).toBeGreaterThan(0);
    expect(x1 - avant.x).toBeLessThan((PLAYER_SPEED * DT) / 2);
    expect(x2 - x1).toBeCloseTo(2 * (x1 - avant.x), 6);
  }, 60_000);

  it('etape 17 : un etalage du pendant le vote attend le verdict RESTER, et s ouvre au tick qui suit', () => {
    const room = new Room(4242);
    room.join(1);
    ouvrirLePortail(room);
    room.drainLevelUps();
    room.drainDraftOpens();
    // Un coffre ET un niveau dus pendant le vote : la priorite fixe joue apres.
    room.debugOweChests(1);
    room.debugOweLevels(1);
    for (let t = 0; t < TICK_HZ; t++) {
      pas(room);
    }
    expect(room.portalOpen).toBe(true);
    expect(room.drainLevelUps()).toEqual([]);
    expect(room.drainDraftOpens()).toEqual([]);

    room.setVote(1, VOTE_CHOICE.STAY);
    pas(room);
    const verdict = room.tick;
    expect(room.drainPortalResults().map((r) => r.effectTick)).toEqual([verdict]);
    // Le tick du verdict n'ouvre rien : le garde du portail a rendu la main
    // AVANT l'ouverture d'un etalage du.
    expect(room.drainDraftOpens()).toEqual([]);

    pas(room);
    // Un seul etalage, le coffre, au premier pas qui suit le verdict.
    expect(room.drainLevelUps().map((l) => l.tick)).toEqual([verdict + 1]);
    expect(room.drainDraftOpens()).toHaveLength(1);
  }, 60_000);

  it('etape 17 : PARTIR termine la run sans ouvrir l etalage du', () => {
    const room = new Room(4242);
    room.join(1);
    ouvrirLePortail(room);
    room.drainLevelUps();
    room.drainDraftOpens();
    room.debugOweLevels(1);

    room.setVote(1, VOTE_CHOICE.LEAVE);
    pas(room);
    expect(room.drainPortalResults().map((r) => r.decision)).toEqual([VOTE_CHOICE.LEAVE]);
    expect(room.drainRunOver()).not.toBeNull();

    // L'etalage du est abandonne avec la run : `#runOver` rend la main avant.
    for (let t = 0; t < TICK_HZ; t++) {
      pas(room);
    }
    expect(room.drainLevelUps()).toEqual([]);
    expect(room.drainDraftOpens()).toEqual([]);
  }, 60_000);

  it('etape 17 : un vote pendant la rampe de reprise est refuse, sans second verdict', () => {
    const room = new Room(4242);
    room.join(1);
    ouvrirLePortail(room);
    room.setVote(1, VOTE_CHOICE.STAY);
    pas(room);
    expect(room.drainPortalResults()).toHaveLength(1);

    // C + 1 : la rampe a commence, le portail est ferme au salon.
    pas(room);
    expect(room.setVote(1, VOTE_CHOICE.LEAVE)).toBe(false);
    for (let t = 0; t < LEVEL_RESUME_TICKS; t++) {
      pas(room);
    }
    expect(room.drainPortalResults()).toEqual([]);
    expect(room.drainRunOver()).toBeNull();
    expect(room.portalOpen).toBe(false);
  }, 60_000);

  it('etape 17 : un MORT vote pendant le gel, sa voix compte, et il reste a terre', () => {
    const room = new Room(4242);
    room.join(1);
    room.join(2);
    room.debugKill(1);
    expect(room.hpOf(1)).toBe(0);
    ouvrirLePortail(room);

    for (let t = 0; t < TICK_HZ; t++) {
      pas(room);
    }
    expect(room.hpOf(1)).toBe(0);
    // Le mort et le vif partent : deux voix sur deux, le portail se ferme
    // avant l'echeance.
    expect(room.setVote(1, VOTE_CHOICE.LEAVE)).toBe(true);
    expect(room.setVote(2, VOTE_CHOICE.LEAVE)).toBe(true);
    pas(room);
    expect(room.drainPortalResults().map((r) => r.decision)).toEqual([VOTE_CHOICE.LEAVE]);
    expect(room.hpOf(1)).toBe(0);
  }, 60_000);

  it('etape 17 : le minuteur d un evenement dort pendant le vote et sa rampe, puis repart', () => {
    // Le premier evenement et le premier portail tombent tous deux vers la
    // vague 20 (`EVENT_FIRST_WAVE`, `PORTAL_EVERY_WAVES`) : un evenement qui
    // court pendant le vote est le cas ORDINAIRE.
    const room = new Room(4242);
    room.join(1);
    ouvrirLePortail(room);
    room.drainEvents();
    room.debugStartEvent(7 * 0x4_6a2b + EVENT_KIND.SCEAUX);
    expect(room.drainEvents().map((m) => m.type)).toEqual([MSG.EVENT_START]);

    for (let t = 0; t < 3 * TICK_HZ; t++) {
      pas(room);
    }
    // Trois secondes de vote : a 5 Hz, quinze EVENT_STATE si le minuteur
    // tournait.
    expect(room.drainEvents()).toEqual([]);

    room.setVote(1, VOTE_CHOICE.STAY);
    pas(room);
    for (let t = 0; t < LEVEL_RESUME_TICKS; t++) {
      pas(room);
    }
    // La rampe aussi : `#stepEvent` dort tant que `#tick <= #resumeEndTick`.
    expect(room.drainEvents()).toEqual([]);

    for (let t = 0; t < EVENT_STATE_PERIOD_TICKS; t++) {
      pas(room);
    }
    expect(room.drainEvents().map((m) => m.type)).toContain(MSG.EVENT_STATE);
  }, 60_000);

  it('etape 17 : un verbe est refuse pendant le vote et au tick du verdict, comme pendant un etalage', () => {
    // La passe interfaces (3c1b007) refuse deja les verbes pendant un etalage
    // et le gel qui le suit (`verbes.test.ts`) ; le portail, que
    // `#freezeUntilTick` ne couvre pas, doit faire de meme.
    const room = new Room(4242);
    room.join(1, undefined, undefined, 0); // Amorce
    ouvrirLePortail(room);
    const p = positionOf(room, 1);
    expect(room.useAbility(1, p.x, p.y)).toBeNull();

    room.setVote(1, VOTE_CHOICE.STAY);
    pas(room);
    expect(room.drainPortalResults()).toHaveLength(1);
    // Le tick du verdict est encore gele (`#freezeUntilTick = C`).
    expect(room.useAbility(1, p.x, p.y)).toBeNull();

    pas(room);
    expect(room.useAbility(1, p.x, p.y)).not.toBeNull();
  }, 60_000);
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd back && npx vitest run src/room.test.ts -t "portail"`
Attendu : FAIL — « LE MONDE GELE » (le joueur a avancé, la horde aussi, des vagues sont sorties),
« en solo… la rampe » (le joueur bouge au tick du verdict), « un etalage du… » (l'étalage s'ouvre
pendant le vote), « le minuteur d un evenement… » (des `EVENT_STATE` pendant le vote), « un verbe
est refuse pendant le vote… » (`useAbility` rend un `AbilityUsed` pendant le vote). « PARTIR
termine la run sans ouvrir l etalage du », « un vote pendant la rampe » et « un MORT vote… »
peuvent déjà passer ou non selon l'ordre actuel : ce sont des gardes de non-régression.

- [ ] **Étape 3 : le garde du portail**

`back/src/room.ts`, docbloc de `step` : la ligne ` * 1. tick++` (l.1347) devient

```ts
   * 1. tick++ — puis, portail ouvert (etape 17) : seul le vote avance, et
   *    `step` rend la main (le monde est gele, comme pendant un etalage)
```

Dans `step`, entre la fin du garde `#runOver` (le `return;` suivi de `}`, l.1381-1382) et le
commentaire « Un coffre, un evenement ou un niveau attend… » (l.1384), insérer :

```ts
    // Etape 17 : le portail GELE le monde, comme l'etalage. Ni joueurs, ni
    // horde, ni tirs, ni contact, ni ramassages, ni minuteur d'evenement, ni
    // directeur : seul le vote avance, et le tick (il date le verdict).
    //
    // ⚠️ **AVANT l'ouverture d'un etalage du** : un niveau, un coffre ou un
    // evenement reussi pendant le vote attend le verdict, et s'ouvre au premier
    // pas qui suit un « rester ». Portail et etalage ne se chevauchent jamais.
    if (this.portalOpen) {
      this.#stepPortal();
      return;
    }
```

Bloc des vagues (l.1566-1571) : remplacer

```ts
    // ⚠️ **Le portail s'ouvre toutes les `PORTAL_EVERY_WAVES` vagues**, et
    // seulement la : la mort d'un boss ne l'ouvre pas. Une vague = un groupe,
    // quel que soit son nombre d'ordres.
    if (vague.length > 0) {
      this.#wavesSincePortal++;
      if (this.#wavesSincePortal >= PORTAL_EVERY_WAVES && !this.portalOpen) {
```

par

```ts
    // ⚠️ **Le portail s'ouvre toutes les `PORTAL_EVERY_WAVES` vagues**, et
    // seulement la : la mort d'un boss ne l'ouvre pas. Une vague = un groupe,
    // quel que soit son nombre d'ordres.
    //
    // Etape 17 : il s'ouvre ICI, apres les ordres, et le monde finit ce pas ;
    // le gel commence au pas suivant (`deadlineTick − PORTAL_WINDOW_TICKS + 1`,
    // ce que le client deduit). Aucune vague ne sort pendant un vote : le
    // garde de tete a deja rendu la main.
    if (vague.length > 0) {
      this.#wavesSincePortal++;
      if (this.#wavesSincePortal >= PORTAL_EVERY_WAVES) {
```

Fin de `step` (l.1878-1887) : remplacer

```ts
    this.#stepEvent(dt);
    this.#checkRunOver();
    // ⚠️ **APRES `#checkRunOver`, et SANS garde de fin de run.** Si l'equipe
    // est effacee au tick ou le portail tranche, l'effacement a deja ramene la
    // cagnotte a `WIPE_GOLD_KEPT` : un « partir » resolu juste apres majore
    // cette cagnotte-la, ce que le snapshot du meme tick dit aussi.
    //
    // Rien au-dessus de cette ligne ne consulte le portail : le monde a tourne
    // tout entier pendant le vote.
    this.#stepPortal();
```

par

```ts
    this.#stepEvent(dt);
    this.#checkRunOver();
    // Etape 17 : le vote avance en tete de `step`, monde gele — jamais ici. Une
    // equipe ne peut donc plus etre effacee pendant qu'elle negocie.
```

⚠️ **Le bloc qui suit reste tel quel** (l.1889-1911, « Arrondies, comme sur le fil… » jusqu'à
`this.#history.record(this.#tick, rxs, rys, ids);`) : depuis `18b0999`, l'historique des
vivants s'enregistre en FIN de pas. Le garde de tête rend la main avant lui, comme le gel d'un
étalage : un tick de vote n'enregistre rien, exactement comme un tick d'étalage.

`useAbility` (l.1314-1318) : le garde posé par la passe interfaces devient

```ts
    // Memes gardes que `step` : rien ne se joue apres la fin, pendant un
    // etalage, pendant le vote du portail (etape 17) ni pendant le gel — un
    // verbe pose la s'appliquerait a un monde fige.
    if (
      this.#runOver ||
      this.#draft.phase !== 'closed' ||
      this.portalOpen ||
      this.#tick <= this.#freezeUntilTick
    ) {
      return null;
    }
```

`#stepPortal` (l.2745-2777) : à la fin de son docbloc, avant ` */`, ajouter

```ts
   *
   * Etape 17 : appele seulement depuis le garde de tete de `step`, monde gele.
   * « Rester » pose la MEME reprise qu'un etalage : le tick du verdict reste
   * gele, puis `LEVEL_RESUME_TICKS` de rampe.
```

et la branche `else` du verdict devient :

```ts
    } else {
      // Rester laisse la cagnotte NON SECURISEE, c'est tout le risque ; ce qui
      // monte, c'est ce qu'elle vaudra au bout du palier suivant.
      this.#extractMultiplier += EXTRACT_MULTIPLIER_STEP;
      // Etape 17 : la reprise d'un etalage, au tick pres — le client la deduit
      // de `effectTick` (`PORTAL_RESULT`).
      this.#freezeUntilTick = this.#tick;
      this.#resumeEndTick = this.#tick + LEVEL_RESUME_TICKS;
    }
```

Getter `portalOpen` (l.769-772) : la doc devient

```ts
  /** Vrai tant que le vote d'extraction est ouvert. Le monde est alors gele (etape 17, `step`). */
```

- [ ] **Étape 4 : réécrire les commentaires devenus faux**

`back/src/portal.ts`, doc de classe : la ligne du tableau

```ts
 * | le monde | **gele** | **continue de tourner** |
```

devient

```ts
 * | le monde | **gele** | **gele** (etape 17) |
```

et le paragraphe

```ts
 * ⚠️ **Le gel n'est pas absent par oubli.** C'est `Room#step` qui gele ou non,
 * mais la raison se lit ici : un choix de carte n'a pas d'enjeu temporel, alors
 * que pour le vote **le temps EST l'enjeu** — la vague suivante approche
 * pendant qu'on negocie.
```

devient

```ts
 * ⚠️ **Le gel vit dans `Room#step`, pas ici** (etape 17) : decider en pleine
 * horde s'est revele une gene plus qu'un enjeu. On vote a l'abri, et
 * `PORTAL_WINDOW_TICKS` n'est plus qu'un plafond pour l'absent. Cette classe ne
 * fait que compter les voix.
```

`shared/constants.ts`, doc de `PORTAL_WINDOW_TICKS` (l.557-566) :

```ts
/**
 * Duree de la fenetre du vote d'extraction, en ticks (20 s).
 *
 * ⚠️ **Le meme nombre que `DRAFT_WINDOW_TICKS`, et deux constantes quand
 * meme** : deux plafonds sur deux decisions differentes, que le solo
 * court-circuite toutes deux.
 *
 * ⚠️ **Etape 17 : le vote GELE le monde**, comme l'etalage (`Room#step`). Cette
 * fenetre n'est plus l'enjeu, seulement l'attente maximale d'un absent. Le
 * client en deduit le premier tick gele : `deadlineTick − PORTAL_WINDOW_TICKS + 1`.
 */
```

`back/src/server.ts` l.555-559 : remplacer

```ts
    // Le portail, dans le meme ordre que le draft : l'ouverture, les votes en
    // continu, puis le verdict — et tout cela AVANT le snapshot du meme tick.
    //
    // ⚠️ **Rien de tout ceci n'annonce un gel**, a la difference de
    // `DRAFT_OPEN` : le monde continue de tourner pendant le vote.
```

par

```ts
    // Le portail, dans le meme ordre que le draft : l'ouverture, les votes en
    // continu, puis le verdict — et tout cela AVANT le snapshot du meme tick.
    //
    // Etape 17 : comme `LEVEL_UP`, `PORTAL_OPEN` annonce un gel, sans un octet
    // de plus — il commence a `deadlineTick − PORTAL_WINDOW_TICKS + 1` et finit
    // a l'`effectTick` du verdict.
```

- [ ] **Étape 5 : les relancer, ils passent**

Run : `cd back && npx vitest run src/room.test.ts -t "portail" && npx vitest run src/portal.test.ts src/verbes.test.ts`
Attendu : PASS — les tests d'avant du filtre `portail` (dont le réécrit) et les 8 nouveaux, puis
`portal.test.ts` et `verbes.test.ts` entiers (le garde des verbes de la passe interfaces tient
toujours).

- [ ] **Étape 6 : les deux tests sur vraies sockets qui disaient « le monde tourne »**

Les lancer d'abord, pour voir ce que le garde a cassé :

Run : `cd back && npx vitest run src/portal.integration.test.ts`
Attendu : FAIL — « la horde est figee pendant le vote » (l.702) dans le premier test,
`expect(verdictsDe(a)).toHaveLength(0)` (l.963) dans le second.

`back/src/portal.integration.test.ts`, dans le docbloc d'en-tête (l.32-50) : la phrase
« Le monde ne s'arrete pas pendant qu'on negocie. » devient « Le monde est gele pendant qu'on
negocie (etape 17). », et « **Les phases mesurees — le vote, le monde qui tourne — ne sont JAMAIS
accelerees** » devient « **Les phases mesurees — le vote, le monde gele — ne sont JAMAIS
accelerees** ».

Constantes : remplacer le bloc l.74-91 (de `/**` « Distance a laquelle le temoin de « le monde
tourne »… » jusqu'à `const SEUIL_HORDE_PX = 30;`) par

```ts
/**
 * Distance a laquelle le temoin du gel est pose DERRIERE les joueurs, qui
 * envoient « marcher vers la gauche ».
 *
 * ⚠️ **Derriere, pas devant** : un monde qui tournerait par erreur le ferait
 * marcher sur les votants.
 */
const DISTANCE_TEMOIN = 900;

/** Duree de la mesure du gel, en ticks de jeu. */
const TICKS_MESURE = 45;
```

Phase 3 du premier test : le commentaire d'en-tête l.647-655 devient

```ts
    // ---- 3. LE MONDE EST GELE pendant qu'on negocie (etape 17) -------------
    //
    // ⚠️ **La horde ET les joueurs**, et les joueurs ENVOIENT leurs entrees :
    // un gel qui n'arreterait que la horde laisserait marcher les votants.
    // ⚠️ **Les joueurs « marchent » vers la GAUCHE, le temoin est a DROITE** :
    // le boss a laisse son orbe a `DISTANCE_BOSS` a droite de A ; un gel rate
    // ferait ramasser une piece a un tick non reproductible.
```

Le `waitFor` (l.~688-692) garde sa forme ; son libellé `'le monde qui tourne pendant le vote'`
devient `'le monde gele pendant le vote'`. Les assertions l.699-711 (« La horde avance… » jusqu'à la
fin de la boucle des quatre joueurs) deviennent :

```ts
      // La horde est figee...
      expect(monstreApres, 'la horde bouge pendant le vote').toEqual(monstreAvant);
      // ...et les joueurs aussi, les quatre, alors qu'ils envoient « a gauche ».
      for (const client of clients) {
        expect(
          positionDuFil(client).x,
          `le joueur ${client.playerId} bouge pendant le vote`,
        ).toBe(joueursAvant.get(client.playerId));
      }
```

Second test (l.877-964) : son docbloc l.877-884 devient

```ts
  /**
   * **La moitie NEGATIVE, et c'est elle qui porte le sens** : « l'or est acquis
   * quand on part » passerait aussi avec un or qui ne bouge jamais.
   *
   * Meme decor que la moitie positive jusqu'a la mort du boss. Etape 17 : le
   * vote gele le monde, personne ne tombe pendant qu'on negocie — l'equipe
   * choisit de RESTER, puis elle est effacee, et la cagnotte reportee tombe a
   * `WIPE_GOLD_KEPT`.
   */
```

Juste après `expect(cagnotte).toBeGreaterThan(0);` (l.~913), insérer :

```ts
    // Les quatre restent : le portail se ferme avant l'echeance, et c'est la
    // cagnotte REPORTEE qui sera perdue.
    for (const client of clients) {
      client.ws.send(encodeVote(VOTE_CHOICE.STAY));
    }
    const verdict = await verdictVuParTous(clients, 1);
    expect(verdict.decision).toBe(VOTE_CHOICE.STAY);
    expect(verdict.effectTick).toBeLessThan(open.deadlineTick);
```

et la fin du test (l.961-963) devient

```ts
    // ⚠️ **Un seul verdict, « rester »** : une fois `#runOver` vrai, `step` ne
    // rappelle plus personne. Une equipe effacee ne part pas avec la mise.
    expect(verdictsDe(a)).toHaveLength(1);
```

Run : `cd back && npx vitest run src/portal.integration.test.ts`
Attendu : PASS (2 / 2). Un échec isolé de compte ou d'or à 0 se relance une fois (base partagée).

- [ ] **Étape 7 : commit**

```bash
npx biome check --write back/src/room.ts back/src/portal.ts shared/constants.ts back/src/server.ts back/src/room.test.ts back/src/portal.integration.test.ts
git add back/src/room.ts back/src/portal.ts shared/constants.ts back/src/server.ts back/src/room.test.ts back/src/portal.integration.test.ts
git commit -m "feat(back): le portail gele le monde, rester reprend comme un etalage"
```

---

### Tâche 2 : client — le gel du portail, daté au tick et rejoué

**Fichiers :**
- Modifier : `front/src/net/client.ts` (imports `@shared/constants` l.18-35 et `@shared/protocol`
  l.~69-92 ; champs du gel l.1464-1480 ; getter `isFrozen` l.1856-1868 ; branches `LEVEL_UP`
  l.2525-2553, `DRAFT_RESULT` l.2573-2596, `PORTAL_OPEN` l.2597-2611, `PORTAL_RESULT` l.2619-2626 ;
  gardes du champ et du tir l.2768, l.2806 ; `#replayTick` l.3762 ; `#movementScale` l.3770-3783),
  `front/src/ui/hud.ts` (`HudSource` l.66-90 ; texte du badge l.291-296)
- Tester : `front/src/net/client.test.ts` (import des constantes l.4-24 ; deux `describe` en fin de
  fichier), `front/src/ui/hud.test.ts` (`FakeSource` l.~206 ; un test après l.455)

**Interfaces :**
- Consomme (tâche 1) : `PORTAL_OPEN.deadlineTick = T + PORTAL_WINDOW_TICKS`, premier tick gelé
  `T + 1` ; `PORTAL_RESULT.effectTick = C` gelé, rampe `C + 1 … C + LEVEL_RESUME_TICKS` après
  « rester » seulement.
- Produit : `GameClient#freezeIsPortal: boolean` (getter) ; `HudSource.freezeIsPortal?: boolean` ;
  `GameClient#isFrozen` vrai du premier tick gelé à la fin de la rampe, portail compris ;
  `GameClient#draftCards` vide dès `PORTAL_OPEN`. Privés : `#freezeFrom(startTick: number, portal:
  boolean): void`, `#thawAt(endTick: number): void`, `#replayFrom(fromTick: number): void`,
  `#untilAt(tick: number): number`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/net/client.test.ts` : dans l'import de `@shared/constants` (l.4-24), ajouter
`PORTAL_WINDOW_TICKS,` après `PLAYER_SPEED,`. Puis, **en fin de fichier** :

```ts
describe('etape 17 : le portail gele le client, date au tick', () => {
  /**
   * ⚠️ **Des nombres qui ne ressemblent a rien du jeu** : une fixture egale a
   * une constante de production masquerait une constante codee en dur.
   */
  const OUVERTURE = 3_211;
  const ECHEANCE = OUVERTURE + PORTAL_WINDOW_TICKS;
  const VERDICT = OUVERTURE + 97;

  function setup(): { client: GameClient; socket: FakeSocket } {
    const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
    client.connect();
    const socket = latestSocket();
    socket.emit('message', { data: encodeWelcome(1, 0, 0xd8a5_0017) });
    return { client, socket };
  }

  /**
   * Pose le tick de horde par un snapshot vide. ⚠️ **Chaque appel doit sauter
   * de plus d'un tick** (`HORDE_TICK_LAG_TOLERANCE`) ; pour un seul tick, c'est
   * `client.update(0, STEP)`.
   */
  function auTick(socket: FakeSocket, tick: number): void {
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, []) });
  }

  it('PORTAL_OPEN fige a deadlineTick − PORTAL_WINDOW_TICKS + 1 : le tick d ouverture tourne encore', () => {
    const { client, socket } = setup();
    auTick(socket, OUVERTURE);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, 1.5) });

    // Le salon ouvre le portail APRES les ordres de vague, dans le pas de T : T
    // tourne en entier. Geler a la reception figerait T chez ce client seul.
    expect(client.hordeTick).toBe(OUVERTURE);
    expect(client.motionScale).toBe(1);
    expect(client.isFrozen).toBe(false);

    client.update(0, STEP);
    expect(client.hordeTick).toBe(OUVERTURE + 1);
    expect(client.motionScale).toBe(0);
    expect(client.isFrozen).toBe(true);
    expect(client.freezeIsPortal).toBe(true);
  });

  it('PORTAL_RESULT « rester » rend la main a effectTick, par la rampe de reprise', () => {
    const { client, socket } = setup();
    auTick(socket, OUVERTURE);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, 1.5) });
    socket.emit('message', { data: encodePortalResult(VERDICT, VOTE_CHOICE.STAY, 0) });

    // Le tick du verdict est encore gele, comme au salon.
    auTick(socket, VERDICT);
    expect(client.motionScale).toBe(0);
    client.update(0, STEP);
    expect(client.motionScale).toBeCloseTo(1 / LEVEL_RESUME_TICKS, 9);
    // Fin de la rampe : vitesse pleine, mais la perturbation se voit encore.
    auTick(socket, VERDICT + LEVEL_RESUME_TICKS);
    expect(client.motionScale).toBe(1);
    expect(client.isFrozen).toBe(true);
    auTick(socket, VERDICT + LEVEL_RESUME_TICKS + 2);
    expect(client.isFrozen).toBe(false);
  });

  it('PORTAL_RESULT « partir » ne degele pas : le salon a fini la run', () => {
    const { client, socket } = setup();
    auTick(socket, OUVERTURE);
    socket.emit('message', { data: encodePortalOpen(ECHEANCE, 1.5) });
    socket.emit('message', { data: encodePortalResult(VERDICT, VOTE_CHOICE.LEAVE, 0) });
    auTick(socket, VERDICT + LEVEL_RESUME_TICKS + 2);
    expect(client.motionScale).toBe(0);
  });

  it('l etalage d avant, garde pour sa revelation, ne revient pas sous le portail', () => {
    // `DraftScreen` montre l'etalage tant que `isFrozen` (ui/draft.ts) : sans
    // vidage, le dernier etalage reapparaitrait pendant le vote.
    const { client, socket } = setup();
    auTick(socket, OUVERTURE - 200);
    socket.emit('message', { data: encodeLevelUp(OUVERTURE - 150, 2) });
    socket.emit('message', {
      data: encodeDraftOpen(OUVERTURE + 450, [{ nature: CARD.PASSIVE, refId: 3 }]),
    });
    socket.emit('message', { data: encodeDraftResult(OUVERTURE - 140, []) });
    expect(client.draftCards).toHaveLength(1);
    expect(client.freezeIsPortal).toBe(false);

    socket.emit('message', { data: encodePortalOpen(ECHEANCE, 1.5) });
    expect(client.draftCards).toHaveLength(0);
    expect(client.freezeIsPortal).toBe(true);
  });

  it('un LEVEL_UP recu AVANT son tick ne gele pas le present (le gel est date, enfin)', () => {
    // Ecart n° 1 : avant l'etape 17, `LEVEL_UP` gelait des la reception.
    const { client, socket } = setup();
    auTick(socket, OUVERTURE);
    socket.emit('message', { data: encodeLevelUp(OUVERTURE + 5, 2) });
    expect(client.motionScale).toBe(1);
    expect(client.isFrozen).toBe(false);
    auTick(socket, OUVERTURE + 5);
    expect(client.motionScale).toBe(0);
    expect(client.isFrozen).toBe(true);
    expect(client.freezeIsPortal).toBe(false);
  });
});

interface PortalScenarioResult {
  maxDrift: number;
  /** Parcours du temoin de reference pendant le gel strict : 0 si le gel mord. */
  frozenTravel: number;
  /** Parcours apres la reprise complete : un monde qui repart, pas un gel permanent. */
  resumedTravel: number;
}

/**
 * Etape 17 : un portail traverse. La reference gele EXACTEMENT comme
 * `Room#step` : elle tourne pendant le tick d'ouverture `OUVERTURE` (le
 * portail s'ouvre apres les ordres de vague, le monde finit ce pas), ne fait
 * RIEN de `OUVERTURE + 1` a `VERDICT` inclus (ni historique, ni champ, ni
 * horde : `step` revient avant), puis reprend sur `LEVEL_RESUME_TICKS` avec un
 * `dt` mis a l'echelle. Les joueurs ne bougent pas pendant le gel (le salon ne
 * les deplace pas) : leurs positions suivent une horloge VIVANTE.
 *
 * `PORTAL_OPEN` est livre `openDelay` ticks apres l'ouverture, `PORTAL_RESULT`
 * `resultDelay` ticks apres le verdict, AVANT le pas client de ce tick : a 0,
 * le client recoit l'ouverture avant d'avoir simule `OUVERTURE` (le cas
 * ordinaire : il suit le dernier snapshot) ; au-dela de 1, il a deja simule
 * des ticks que le serveur a geles (ou rampes), et doit les rejouer.
 */
function runClientPortalScenario(params: {
  mapSeed: number;
  openDelay: number;
  resultDelay: number;
}): PortalScenarioResult {
  const { mapSeed, openDelay, resultDelay } = params;
  const WAVE_ID = 77;
  const ENTITIES = 40;
  const OUVERTURE = 120;
  const VERDICT = OUVERTURE + GEL_TICKS;
  const TICKS = VERDICT + LEVEL_RESUME_TICKS + 90;

  const ref = makeReferenceServer(mapSeed, ENTITIES);
  const order: WaveOrder = {
    waveId: WAVE_ID,
    spawnTick: 0,
    seed: 0x51ee_d001,
    archetype: 0,
    formation: FORMATION.CLUSTER,
    anchorX: 1200,
    anchorY: 1200,
    count: ENTITIES,
  };
  ref.horde.spawn(order, ref.fields[0]);

  const client = new GameClient('ws://test', () => ({ x: 0, y: 0 }), vi.fn());
  client.connect();
  const socket = latestSocket();
  socket.emit('message', { data: encodeWelcome(1, 0, mapSeed) });
  socket.emit('message', { data: encodeWaveOrder(order) });

  const trackedId = entityIdOf(WAVE_ID, ENTITIES - 1);
  let vivant = 0;
  let maxDrift = 0;
  let frozenTravel = 0;
  let resumedTravel = 0;
  let prev: { x: number; y: number } | null = null;

  for (let tick = 0; tick < TICKS; tick++) {
    const gele = tick > OUVERTURE && tick <= VERDICT;
    if (!gele) {
      vivant++;
    }
    const xs = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.cos(vivant * 0.02 + p) * 1500));
    const ys = [0, 1, 2, 3].map((p) => Math.round(3000 + Math.sin(vivant * 0.02 + p) * 1500));

    if (!gele) {
      ref.playerHistory.record(tick, xs, ys);
      if (tick % STEPS_PER_FIELD === 0) {
        const seen = ref.playerHistory.delayed(tick);
        if (seen) {
          for (let f = 0; f < 4; f++) {
            ref.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
          }
          ref.horde.retarget(seen.x, seen.y);
        }
      }
      // La rampe de `Room#movementScale` : `(tick − VERDICT) / LEVEL_RESUME_TICKS`.
      const echelle = tick > VERDICT ? Math.min(1, (tick - VERDICT) / LEVEL_RESUME_TICKS) : 1;
      ref.horde.step(STEP * echelle, ref.fields, tick);
    }

    const players = xs.map((x, i) => ({
      id: i,
      x,
      y: ys[i] ?? 0,
      hp: 100,
      aimX: 0,
      aimY: 0,
      pickupRadius: ORB_PICKUP_RADIUS,
      shield: 0,
    }));
    socket.emit('message', { data: encodeSnapshot(tick, 0, 0, players) });
    if (tick === OUVERTURE + openDelay) {
      socket.emit('message', { data: encodePortalOpen(OUVERTURE + PORTAL_WINDOW_TICKS, 1) });
    }
    if (tick === VERDICT + resultDelay) {
      socket.emit('message', { data: encodePortalResult(VERDICT, VOTE_CHOICE.STAY, 0) });
    }

    client.update(tick * STEP, STEP);

    // Pendant qu'un message voyage, le client ignore encore ce que le serveur
    // a fait : un ecart du au transit, pas au rejeu. On mesure APRES livraison.
    const enVol =
      (tick > OUVERTURE && tick < OUVERTURE + openDelay) ||
      (tick > VERDICT && tick < VERDICT + resultDelay);
    if (!enVol) {
      maxDrift = Math.max(maxDrift, measureDrift(ref.horde, client.horde, ENTITIES));
    }

    const slot = ref.horde.slotOf(trackedId);
    if (slot >= 0) {
      const pos = { x: ref.horde.x[slot] ?? 0, y: ref.horde.y[slot] ?? 0 };
      if (prev) {
        const d = Math.hypot(pos.x - prev.x, pos.y - prev.y);
        if (gele) {
          frozenTravel += d;
        } else if (tick > VERDICT + LEVEL_RESUME_TICKS) {
          resumedTravel += d;
        }
      }
      prev = pos;
    }
  }

  return { maxDrift, frozenTravel, resumedTravel };
}

describe('etape 17 : un portail traverse, la horde du client reste celle du serveur', () => {
  it('portail a l heure : le tick d ouverture tourne, le gel mord, 0,000 px', () => {
    const r = runClientPortalScenario({ mapSeed: 0x17e_0001, openDelay: 0, resultDelay: 0 });
    process.stdout.write(
      `[etape 17] portail a l heure : derive=${r.maxDrift.toFixed(3)}px, ` +
        `gel=${r.frozenTravel.toFixed(3)}px, reprise=${r.resumedTravel.toFixed(1)}px\n`,
    );
    // Le gel MORD (la reference ne bouge pas) et le monde REPART : sans ces
    // deux lignes, « 0,000 px » pourrait dire « rien n'a bouge ».
    expect(r.frozenTravel).toBe(0);
    expect(r.resumedTravel).toBeGreaterThan(50);
    expect(r.maxDrift).toBeLessThan(0.0005);
  });

  it('PORTAL_OPEN et PORTAL_RESULT en retard de 5 ticks : le rejeu ramene la derive a 0,000 px', () => {
    const r = runClientPortalScenario({ mapSeed: 0x17e_0001, openDelay: 5, resultDelay: 5 });
    process.stdout.write(
      `[etape 17] portail en retard : derive=${r.maxDrift.toFixed(3)}px, ` +
        `gel=${r.frozenTravel.toFixed(3)}px, reprise=${r.resumedTravel.toFixed(1)}px\n`,
    );
    expect(r.frozenTravel).toBe(0);
    expect(r.resumedTravel).toBeGreaterThan(50);
    expect(r.maxDrift).toBeLessThan(0.0005);
  });
});
```

`front/src/ui/hud.test.ts` : dans `FakeSource`, après `draftIsChest = false;` (l.~206), ajouter
`freezeIsPortal = false;`. Après le test « etape 11 : le bandeau de gel dit « Coffre »… » (l.~455) :

```ts
  it('etape 17 : le bandeau de gel dit « Portail » pendant un vote, meme apres un coffre', () => {
    // `draftIsChest` garde la valeur du DERNIER etalage : le portail passe avant.
    source.draftIsChest = true;
    source.freezeIsPortal = true;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Portail — pause…');
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/net/client.test.ts -t "etape 17" && npx vitest run src/ui/hud.test.ts`
Attendu : FAIL — `freezeIsPortal` vaut `undefined` (Vitest ne vérifie pas les types) ; le gel ne prend pas
à `PORTAL_OPEN` (`motionScale` reste 1) ; « partir » / « rester » ne changent rien ;
l'étalage reste ; le `LEVEL_UP` en avance gèle tout de suite (`motionScale` 0 au lieu de 1) ; les
deux scénarios de dérive rapportent une dérive non nulle (le client ne gèle jamais). Le texte du
HUD dit « Coffre — pause… ».

- [ ] **Étape 3 : les bornes datées, les deux aides, le rejeu**

`front/src/net/client.ts`, imports : ajouter `PORTAL_WINDOW_TICKS,` à l'import de
`@shared/constants` (après `PLAYER_SPEED,`) et `VOTE_CHOICE,` à celui de `@shared/protocol`
(ordre alphabétique, Biome le range).

Champs (l.1464-1480) : le docbloc de `#freezeUntilTick` / `#resumeEndTick` garde son texte ; après
`#freezeStartTick = -1;` ajouter :

```ts
  /**
   * Les bornes du gel PRECEDENT, qui valent pour les ticks d'avant
   * `#freezeStartTick` (voir `#untilAt`).
   *
   * ⚠️ **Sans elles, le gel s'appliquerait a la reception** : un `LEVEL_UP` ou
   * un `PORTAL_OPEN` arrive souvent avant que la horde du client n'ait simule
   * les derniers ticks que le serveur a fait tourner, et les bornes poussees a
   * l'infini les gelaient (ecart n° 1 de l'etape 17).
   */
  #prevFreezeUntilTick = -1;
  #prevResumeEndTick = -1;
  /** Le gel courant est-il celui d'un portail (etape 17) ? Le badge du HUD le dit. */
  #freezeIsPortal = false;
```

Après le getter `isFrozen` (l.~1868), ajouter :

```ts
  /** Le gel courant (et sa rampe) vient-il d'un portail ? Voir `#freezeIsPortal`. */
  get freezeIsPortal(): boolean {
    return this.#freezeIsPortal;
  }
```

Branche `LEVEL_UP` : les trois lignes

```ts
      this.#freezeStartTick = msg.tick;
      this.#freezeUntilTick = Number.MAX_SAFE_INTEGER;
      this.#resumeEndTick = Number.MAX_SAFE_INTEGER;
```

deviennent

```ts
      this.#freezeFrom(msg.tick, false);
```

Branche `DRAFT_RESULT` : les deux lignes

```ts
      this.#freezeUntilTick = msg.deadlineTick;
      this.#resumeEndTick = msg.deadlineTick + LEVEL_RESUME_TICKS;
```

deviennent

```ts
      this.#thawAt(msg.deadlineTick);
```

Branche `PORTAL_OPEN` : avant son `return;`, après `this.#portalCloseTick = Number.MAX_SAFE_INTEGER;`,
ajouter :

```ts
      // Etape 17 : le portail GELE le monde. Le salon l'ouvre dans le pas de T
      // (`deadlineTick = T + PORTAL_WINDOW_TICKS`), apres que le monde a tourne :
      // le premier tick gele est T + 1. Duree inconnue, comme un etalage.
      this.#freezeFrom(msg.deadlineTick - PORTAL_WINDOW_TICKS + 1, true);
      // L'etalage d'avant survit a sa fermeture pour sa revelation, et
      // `DraftScreen` le montre tant que `isFrozen` : sans ce vidage, il
      // reapparaitrait sous le portail. Aucun etalage n'est ouvert ici : un
      // etalage gele le monde, aucune vague ne sort.
      this.#draftCards = [];
```

Branche `PORTAL_RESULT` : avant son `return;`, après `this.#portalCloseTick = msg.effectTick;`,
ajouter :

```ts
      // Etape 17 : « rester » reprend comme apres un etalage, le tick du verdict
      // encore gele. « Partir » ne reprend rien : le salon a fini la run.
      if (msg.decision === VOTE_CHOICE.STAY) {
        this.#thawAt(msg.effectTick);
      }
```

Les trois gardes `tick > this.#freezeUntilTick` (dans `#advanceHorde` l.2768 et l.2806, dans
`#replayTick` l.3762) deviennent `tick > this.#untilAt(tick)` :

```ts
    if (tick > this.#untilAt(tick) && tick % STEPS_PER_FIELD === 0) {
```

```ts
    if (tick > this.#untilAt(tick)) {
```

```ts
    if (tick > this.#untilAt(tick) && tick % STEPS_PER_FIELD === 0) {
```

`#movementScale` (l.3770-3783) est remplacé par ce bloc (son docbloc gardé, les quatre aides
avant lui) :

```ts
  /**
   * Un gel commence a `startTick` (`LEVEL_UP`, `PORTAL_OPEN`), pour une duree
   * inconnue : ses deux bornes hautes sont repoussees a l'infini jusqu'a ce que
   * `#thawAt` les pose.
   *
   * ⚠️ **Date, jamais applique a la reception** : les ticks d'avant `startTick`
   * gardent les bornes du gel precedent (`#untilAt`). Et si la horde a deja
   * simule `startTick` (message en retard), ces ticks sont REJOUES geles, comme
   * une mort tardive (`#replayFrom`).
   */
  #freezeFrom(startTick: number, portal: boolean): void {
    this.#prevFreezeUntilTick = this.#freezeUntilTick;
    this.#prevResumeEndTick = this.#resumeEndTick;
    this.#freezeStartTick = startTick;
    this.#freezeUntilTick = Number.MAX_SAFE_INTEGER;
    this.#resumeEndTick = Number.MAX_SAFE_INTEGER;
    this.#freezeIsPortal = portal;
    this.#replayFrom(startTick);
  }

  /**
   * La fin du gel (`DRAFT_RESULT`, `PORTAL_RESULT` « rester ») : gele jusqu'a
   * `endTick` inclus, puis `LEVEL_RESUME_TICKS` de rampe. Les ticks deja
   * simules apres `endTick` (message en retard) sont rejoues avec la rampe.
   */
  #thawAt(endTick: number): void {
    this.#freezeUntilTick = endTick;
    this.#resumeEndTick = endTick + LEVEL_RESUME_TICKS;
    this.#replayFrom(endTick + 1);
  }

  /**
   * Rejoue depuis `fromTick`, avec les bornes qui viennent d'arriver, les ticks
   * que la horde a DEJA simules. Rien si elle ne l'a pas encore atteint.
   *
   * ponytail: trop vieux pour l'anneau (`ROLLBACK_DEPTH_TICKS`), on ne rejoue
   * pas et l'ecart reste ; un compteur au HUD comme `lateDeaths` si ca se voit.
   */
  #replayFrom(fromTick: number): void {
    const current = this.#lastHordeTick - 1;
    if (fromTick > current || !this.#hordeHistory.restore(fromTick - 1, this.horde)) {
      return;
    }
    this.#primeFieldForReplay(fromTick - 1);
    for (let t = fromTick; t <= current; t++) {
      this.#replayTick(t);
    }
  }

  /** Le dernier tick gele qui vaut pour `tick` : celui du gel courant des son debut, du precedent avant. */
  #untilAt(tick: number): number {
    return tick < this.#freezeStartTick ? this.#prevFreezeUntilTick : this.#freezeUntilTick;
  }

  /**
   * Facteur applique au `dt` de tout ce qui bouge (la horde) : `0` pendant
   * le gel strict, une rampe de `0` (exclu) a `1` pendant les
   * `LEVEL_RESUME_TICKS` qui suivent, `1` en fonctionnement normal. Miroir
   * exact de `Room#movementScale` cote serveur — necessaire pour que le rejeu
   * d'un tick gele ou en reprise avance exactement comme le serveur l'a fait.
   */
  #movementScale(tick: number): number {
    const resumeEnd = tick < this.#freezeStartTick ? this.#prevResumeEndTick : this.#resumeEndTick;
    if (tick > resumeEnd) {
      return 1;
    }
    const sinceFreezeEnd = tick - this.#untilAt(tick);
    return Math.min(1, Math.max(0, sinceFreezeEnd / LEVEL_RESUME_TICKS));
  }
```

- [ ] **Étape 4 : le badge du HUD**

`front/src/ui/hud.ts`, `HudSource` : après `readonly draftIsEvent?: boolean;`, ajouter

```ts
  /** Le gel en cours vient d'un portail (etape 17) : le bandeau de gel le dit. Absent : non. */
  readonly freezeIsPortal?: boolean;
```

Le texte du badge (l.292-296) devient :

```ts
  // Etape 11 : un coffre gele comme un niveau, mais il le dit. Etape 17 : le
  // portail aussi, et il passe AVANT — `draftIsChest` garde la valeur du
  // dernier etalage.
  el.freeze.textContent = source.freezeIsPortal
    ? 'Portail — pause…'
    : source.draftIsChest
      ? 'Coffre — pause…'
      : source.draftIsEvent
        ? 'Événement — pause…'
        : 'Niveau supérieur — pause…';
```

- [ ] **Étape 5 : les relancer, ils passent — et rien d'autre ne bouge**

Run : `cd front && npx vitest run src/net/client.test.ts src/ui/hud.test.ts src/ui/draft.test.ts src/net/evenement.test.ts src/net/ping.test.ts src/net/prediction.test.ts`
Attendu : PASS. Les deux lignes `[etape 17] … derive=0.000px, gel=0.000px` s'impriment. La ligne
`[tache 10] gel : avant=…` passe de ~53 px à plusieurs centaines (le gel est enfin daté, écart
n° 1) ; `pendant=0.000px` inchangé.

⚠️ Si une dérive n'est pas nulle : c'est un vrai écart entre `Room#step` et le client
(superpowers:systematic-debugging), **jamais** un seuil à desserrer.

- [ ] **Étape 6 : les contre-épreuves (puis annulées)**

1. Dans `#freezeFrom`, commenter `this.#replayFrom(startTick);` → « en retard de 5 ticks » rougit
   (dérive non nulle). Rétablir.
2. Dans `#untilAt` et `#movementScale`, lire toujours les bornes courantes (remplacer les deux
   ternaires par `this.#freezeUntilTick` / `this.#resumeEndTick`) → « portail a l heure » et « un
   LEVEL_UP recu AVANT son tick » rougissent. Rétablir.

Run : `git diff --stat` — seuls les fichiers de la tâche.

- [ ] **Étape 7 : commit**

```bash
npx biome check --write front/src/net/client.ts front/src/net/client.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts
git add front/src/net/client.ts front/src/net/client.test.ts front/src/ui/hud.ts front/src/ui/hud.test.ts
git commit -m "feat(front): le gel du portail, date au tick et rejoue s il arrive en retard"
```

---

### Tâche 3 : l'écran — une carte compacte au centre

**Fichiers :**
- Modifier : `front/src/ui/portal.ts` (réécrit en entier), `front/index.html` (section
  `#portal-layer` et son commentaire, l.587-605), `front/src/styles/main.css` (bloc « Vote
  d'extraction » l.1320-1361), `front/src/main.ts` (`setPaused` l.479-485 ; construction de
  `PortalScreen` l.656-665)
- Tester : `front/src/ui/portal.test.ts`

**Interfaces :**
- Consomme : `PortalSource` (inchangée) ; `playerColor`, `remainingSeconds` (`./draft`) ;
  `extractGold` (`@shared/paliers`).
- Produit : `new PortalScreen(root, status, choices, voters, source)` — **quatre** éléments, plus de
  `stakes` ; `leaveGold`, `stayGold`, `formatGold`, `THIN_SPACE`, `voteState`, `voteLabel`
  inchangés de signature (`voteLabel(NO_VOTE)` vaut désormais `'…'`) ; `stakeLines` et
  `formatMultiplier` supprimés. Dans le DOM : `button[data-choice="leave"|"stay"]` (avec
  `data-mine`), `[data-gold="leave"|"stay"]` (le montant), `.portal-voter[data-choice]`. La tâche 4
  ajoute `portalKeyChoice` et `PortalScreen#vote` à ce fichier.

- [ ] **Étape 1 : réécrire les tests de l'écran**

`front/src/ui/portal.test.ts` (⚠️ depuis `7e4f8ab`, les textes affichés portent l'apostrophe
typographique `’` — `'n’a pas voté'`, `L’équipe …` ; les attentes ci-dessous la gardent) :

1. Import (l.10-21) : retirer `formatMultiplier` et `stakeLines`.
2. `interface Harness` (l.59-67) et `harness()` (l.79-100) : retirer `stakes` partout ; `harness()`
   devient

```ts
function harness(): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'portal';
  root.className = 'hidden';
  const status = document.createElement('p');
  const choices = document.createElement('div');
  const voters = document.createElement('div');
  root.append(status, choices, voters);
  document.body.append(root);
  const client = new FakeClient();
  return {
    root,
    status,
    choices,
    voters,
    client,
    screen: new PortalScreen(root, status, choices, voters, client),
  };
}
```

3. `stakeText` (l.138-140) devient

```ts
/** Le montant sous un bouton, tel qu'il s'affiche. */
function goldText(h: Harness, which: 'leave' | 'stay'): string {
  return h.choices.querySelector(`[data-gold="${which}"]`)?.textContent ?? '';
}
```

4. Le `describe('le cablage vers index.html', …)` (l.142-175) devient

```ts
describe('le cablage vers index.html', () => {
  it('trouve les quatre elements que main.ts va chercher', () => {
    // `el()` dans `main.ts` LEVE quand un identifiant manque : renommer l'un
    // d'eux casse le demarrage du jeu entier, pas seulement le vote.
    for (const id of ['portal', 'portal-status', 'portal-choices', 'portal-voters']) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
    // Les lignes d'enjeu ont disparu : un element orphelin ne se verrait pas.
    expect(indexHtml).not.toContain('id="portal-stakes"');
  });

  /**
   * ⚠️ **Etape 17 : le vote GELE le monde**, comme l'etalage : un voile, mais
   * LEGER, et qui ne vole aucun clic hors de la carte.
   */
  it('pose le vote en carte sur un voile plein ecran, le pointeur rendu hors de la carte', () => {
    document.body.innerHTML = indexHtml;
    const portal = document.getElementById('portal');
    const carte = document.getElementById('portal-status')?.parentElement;

    expect(portal?.className).toContain('veil');
    expect(portal?.className).toContain('inset-0');
    expect(portal?.className).toContain('pointer-events-none');
    expect(carte?.className).toContain('pointer-events-auto');
    expect(carte?.className).toContain('w-[520px]');
  });
});
```

5. Supprimer le `describe('formatMultiplier — la progression de la mise', …)` (l.189-196) et, dans
   `describe("les deux chiffres de l'enjeu", …)`, le test « dit AUSSI que tout se perd… »
   (l.239-243).
6. Le `describe('voteLabel — l abstention est un etat A PART', …)`, premier test (l.200-207) :

```ts
  it('donne trois mots DIFFERENTS et courts aux trois etats', () => {
    const mots = [voteLabel(VOTE_CHOICE.LEAVE), voteLabel(VOTE_CHOICE.STAY), voteLabel(NO_VOTE)];

    expect(new Set(mots).size).toBe(3);
    expect(voteLabel(VOTE_CHOICE.LEAVE)).toBe('part');
    expect(voteLabel(VOTE_CHOICE.STAY)).toBe('reste');
    // Etape 17 : pas de libelle long sur une pastille.
    expect(voteLabel(NO_VOTE)).toBe('…');
  });
```

7. Dans `describe('PortalScreen — ce que le joueur voit', …)` :
   - « decompte les secondes a partir du TICK de horde » : les deux attentes deviennent
     `'Portail — 8 s'` et `'Portail — 3 s'` ;
   - « ne descend jamais sous zero, meme apres l echeance » : `'Portail — 0 s'` ;
   - « affiche les DEUX montants, et ils sont differents » (l.293-311) devient

```ts
  it('affiche un montant sous chaque bouton, et « si l equipe tient » sous Rester seulement', () => {
    ouvert(h);
    h.screen.update();

    expect(goldText(h, 'leave')).toBe(`${formatGold(extractGold(CAGNOTTE, MULTIPLICATEUR))} or`);
    expect(goldText(h, 'stay')).toBe(
      `${formatGold(extractGold(CAGNOTTE, MULTIPLICATEUR + EXTRACT_MULTIPLIER_STEP))} or`,
    );
    expect(goldText(h, 'leave')).not.toBe(goldText(h, 'stay'));
    // Le multiplicateur ne s'ecrit plus en toutes lettres (spec §3).
    expect(h.root.textContent).not.toContain('×');
    expect(boutonDe(h, VOTE_CHOICE.STAY).parentElement?.textContent).toContain(
      'si l’équipe tient',
    );
    expect(boutonDe(h, VOTE_CHOICE.LEAVE).parentElement?.textContent).not.toContain('tient');
  });

  it('montre la touche de chaque bouton : 1 part, 2 reste', () => {
    ouvert(h);
    h.screen.update();

    expect(boutonDe(h, VOTE_CHOICE.LEAVE).textContent).toBe('Partir1');
    expect(boutonDe(h, VOTE_CHOICE.STAY).textContent).toBe('Rester2');
    expect(boutonDe(h, VOTE_CHOICE.LEAVE).querySelector('kbd')?.textContent).toBe('1');
  });
```

   - « suit l or du snapshot d une image a l autre » (l.313-330) : ses deux attentes
     `stakeText(h, 'leave')).toContain(…)` deviennent
     `goldText(h, 'leave')).toBe(\`${formatGold(extractGold(CAGNOTTE, MULTIPLICATEUR))} or\`)` puis
     `goldText(h, 'leave')).toBe(\`${formatGold(extractGold(CAGNOTTE + 2_500, MULTIPLICATEUR))} or\`)` ;
   - « montre le vote de CHAQUE joueur, abstention comprise et DISTINCTE » : la troisième ligne
     attendue devient `{ id: '4', choice: 'none', label: '…' }` ;
   - « affiche le verdict PARTIR avec l or acquis, et ferme les deux faces » : l'attente du statut
     devient `` expect(h.status.textContent).toBe(`L’équipe part — 14${THIN_SPACE}723 or`); `` ;
   - « affiche le verdict RESTER avec l or toujours en jeu » devient

```ts
  it('affiche le verdict RESTER, sans montant : la cagnotte reste en jeu', () => {
    ouvert(h);
    h.screen.update();
    h.client.portalDecision = VOTE_CHOICE.STAY;
    h.client.portalGold = 14_723;
    h.screen.update();

    expect(h.status.textContent).toBe('L’équipe reste');
  });
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/ui/portal.test.ts`
Attendu : FAIL — `PortalScreen` attend cinq éléments (le sixième argument devient `undefined`),
pas de `[data-gold]`, titres « Le portail est ouvert — … », `#portal-stakes` encore là, pas de
voile.

- [ ] **Étape 3 : la carte**

`front/src/ui/portal.ts`, en entier (textes affichés à l'apostrophe typographique `’`, comme depuis
`7e4f8ab` ; commentaires sans accents, apostrophe droite) :

```ts
import { EXTRACT_MULTIPLIER_STEP } from '@shared/constants';
import { extractGold } from '@shared/paliers';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';

import { playerColor, remainingSeconds } from './draft';

/**
 * L'ecran du vote d'extraction : une carte compacte, au centre (etape 17).
 *
 * 1. **Les votes des autres sont visibles, en continu** — une pastille par
 *    joueur, a sa couleur. **L'abstention aussi** : « n'a pas vote » et
 *    « a vote RESTER » sont deux etats differents.
 * 2. **Un montant par bouton** : l'or acquis en partant, l'or vise en restant
 *    « si l'equipe tient ». Le multiplicateur ne s'ecrit plus.
 * 3. **Le chronometre se derive du TICK**, comme celui du draft.
 *
 * ⚠️ **Le portail GELE le monde** (`Room#step`, etape 17) : on decide a l'abri,
 * d'ou un voile leger comme l'etalage. Le voile ne capte pas le pointeur ;
 * seule la carte le reprend.
 *
 * ⚠️ **L'ecran ne se cache PAS pour un joueur mort** : tout joueur connecte
 * vote, mort ou vif. Aucune condition a ecrire : `PortalSource` ne porte pas
 * de points de vie.
 */

/** Ce que l'ecran lit — la surface de `GameClient` qui concerne le vote, et rien d'autre. */
export interface PortalSource {
  readonly localId: number | null;
  readonly hordeTick: number;
  readonly portalOpen: boolean;
  readonly portalDeadlineTick: number;
  readonly portalMultiplier: number;
  readonly portalVotes: ReadonlyMap<number, number>;
  readonly portalDecision: number | null;
  readonly portalGold: number;
  /** La cagnotte NON SECURISEE, telle que le snapshot la porte a chaque tick. */
  readonly gold: number;
  castVote(choice: number): void;
}

/**
 * Le separateur des milliers : U+202F, espace fine insecable.
 *
 * ⚠️ **Ecrit par `fromCharCode`, pas comme caractere litteral** : le formateur
 * du depot reecrit `' '` en caractere reel, une espace INVISIBLE dans la
 * source qu'un editeur pourrait normaliser sans bruit.
 */
export const THIN_SPACE = String.fromCharCode(0x202f);

/**
 * Un montant d'or, groupe par milliers.
 *
 * ⚠️ **Groupe a la main plutot que par `toLocaleString`** : les separateurs
 * d'`Intl` changent d'une version de Node a l'autre, et les tests rougiraient
 * sur une montee de runtime.
 */
export function formatGold(gold: number): string {
  return `${Math.round(gold)}`.replace(/\B(?=(\d{3})+(?!\d))/g, THIN_SPACE);
}

/**
 * Ce qu'un joueur a decide, en un mot court — **l'abstention en est un a part
 * entiere**.
 *
 * ⚠️ **« … » (pas encore vote) ne doit JAMAIS se confondre avec « reste »** :
 * le serveur ne compte pas l'abstention (`Portal#decide`), et un joueur
 * croirait sinon avoir une majorite acquise alors que des voix manquent.
 *
 * Tout ce qui n'est ni `STAY` ni `LEAVE` (`NO_VOTE`, ou un octet fantaisiste)
 * se lit comme une abstention.
 */
export function voteLabel(choice: number): string {
  if (choice === VOTE_CHOICE.LEAVE) {
    return 'part';
  }
  if (choice === VOTE_CHOICE.STAY) {
    return 'reste';
  }
  return '…';
}

/** L'etat d'un votant, tel qu'il s'ecrit dans `data-choice` — donc tel que les tests le lisent. */
export type VoteState = 'leave' | 'stay' | 'none';

export function voteState(choice: number): VoteState {
  if (choice === VOTE_CHOICE.LEAVE) {
    return 'leave';
  }
  return choice === VOTE_CHOICE.STAY ? 'stay' : 'none';
}

/**
 * Ce qu'on ACQUIERT en partant maintenant : la cagnotte, majoree du
 * multiplicateur courant.
 *
 * ⚠️ **Passe par `extractGold`, jamais par une multiplication ecrite ici** :
 * c'est la fonction que `Room#stepPortal` appelle pour l'or reellement verse
 * (arrondi et borne `GOLD_MAX` compris). L'ecran annonce donc ce que le joueur
 * recevra.
 */
export function leaveGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier);
}

/**
 * Ce que la MEME cagnotte vaudrait au portail suivant, si l'equipe reste et
 * tient le palier.
 *
 * ⚠️ **Le multiplicateur suivant se DERIVE, il ne voyage pas** : `PORTAL_OPEN`
 * porte le courant, le suivant vaut `+ EXTRACT_MULTIPLIER_STEP`, constante
 * partagee que `Room#stepPortal` ajoute aussi.
 *
 * ⚠️ **Ce n'est PAS une promesse** : la cagnotte peut grossir, ou se perdre si
 * l'equipe tombe. C'est le « si l'equipe tient » sous le bouton qui le dit.
 */
export function stayGold(gold: number, multiplier: number): number {
  return extractGold(gold, multiplier + EXTRACT_MULTIPLIER_STEP);
}

interface ChoiceCell {
  root: HTMLButtonElement;
  choice: number;
  /** Le montant affiche sous le bouton. */
  gold: HTMLElement;
}

/** Les deux faces, dans l'ordre affiche, avec leur touche (voir `portalKeyChoice`). */
const FACES = [
  { choice: VOTE_CHOICE.LEAVE, label: 'Partir', key: '1' },
  { choice: VOTE_CHOICE.STAY, label: 'Rester', key: '2' },
] as const;

export class PortalScreen {
  readonly #root: HTMLElement;
  readonly #status: HTMLElement;
  readonly #choices: HTMLElement;
  readonly #voters: HTMLElement;
  readonly #source: PortalSource;

  #cells: ChoiceCell[] = [];

  constructor(
    root: HTMLElement,
    status: HTMLElement,
    choices: HTMLElement,
    voters: HTMLElement,
    source: PortalSource,
  ) {
    this.#root = root;
    this.#status = status;
    this.#choices = choices;
    this.#voters = voters;
    this.#source = source;
  }

  /** A appeler a chaque image : l'ecran n'a pas d'horloge propre, il lit le client. */
  update(): void {
    const source = this.#source;
    const visible = source.portalOpen;
    this.#root.classList.toggle('hidden', !visible);
    this.#root.classList.toggle('flex', visible);
    if (!visible) {
      return;
    }
    if (this.#cells.length === 0) {
      this.#build();
    }
    this.#paint();
  }

  /**
   * Les deux faces, construites une seule fois : un bouton (libelle et
   * touche), son montant dessous, et « si l'equipe tient » sous Rester.
   */
  #build(): void {
    this.#choices.replaceChildren();
    this.#cells = FACES.map(({ choice, label, key }) => {
      const state = voteState(choice);
      const option = document.createElement('div');
      option.className = 'portal-option';

      const root = document.createElement('button');
      root.type = 'button';
      // Partir quitte la run : le bouton rouge des sorties.
      root.className = `btn btn--tab ol portal-choice${choice === VOTE_CHOICE.LEAVE ? ' btn--red' : ''}`;
      root.dataset.choice = state;
      const hint = document.createElement('kbd');
      hint.className = 'portal-choice__key';
      hint.textContent = key;
      root.append(label, hint);
      root.addEventListener('click', () => {
        this.#onVote(choice);
      });

      const gold = document.createElement('span');
      gold.className = 'portal-option__gold f-jer ol';
      gold.dataset.gold = state;
      option.append(root, gold);

      if (choice === VOTE_CHOICE.STAY) {
        const note = document.createElement('span');
        note.className = 'portal-option__note';
        note.textContent = 'si l’équipe tient';
        option.append(note);
      }
      this.#choices.append(option);
      return { root, choice, gold };
    });
  }

  /**
   * **Cliquer une face EST le vote**, comme le jeton du draft.
   *
   * Recliquer la face choisie la **retire** (`NO_VOTE`) : une voix qu'on ne
   * pourrait plus reprendre ferait de la negociation une course au clic. C'est
   * aussi le seul geste qui dise « je vous laisse decider ».
   *
   * ⚠️ **On lit le vote du SERVEUR, jamais un vote local optimiste** : le
   * client envoie, et affiche ce que `VOTES` rediffuse.
   */
  #onVote(choice: number): void {
    const mine = this.#source.localId;
    const already = mine === null ? undefined : this.#source.portalVotes.get(mine);
    this.#source.castVote(already === choice ? NO_VOTE : choice);
  }

  #paint(): void {
    const source = this.#source;
    const mine = source.localId;
    const decision = source.portalDecision;
    const settled = decision !== null;

    this.#root.dataset.settled = settled ? 'true' : 'false';
    this.#status.textContent = this.#statusLine(decision);

    for (const cell of this.#cells) {
      // L'or vient du SNAPSHOT ; le monde est gele pendant le vote, mais
      // l'ecran ne decide rien : il relit a chaque image.
      const montant =
        cell.choice === VOTE_CHOICE.LEAVE
          ? leaveGold(source.gold, source.portalMultiplier)
          : stayGold(source.gold, source.portalMultiplier);
      cell.gold.textContent = `${formatGold(montant)} or`;
      cell.root.dataset.mine =
        mine !== null && source.portalVotes.get(mine) === cell.choice ? 'true' : 'false';
      // Cliquable tant que le verdict n'est pas tombe : ensuite le portail est
      // ferme cote serveur, et un `VOTE` serait refuse.
      cell.root.disabled = settled;
    }

    // ⚠️ Tri par identifiant : l'ordre d'iteration d'une `Map` suit l'ordre
    // d'arrivee des messages, donc la latence. Les votants sauteraient de place
    // a chaque rafraichissement.
    const voters = [...source.portalVotes].sort((a, b) => a[0] - b[0]);
    this.#voters.replaceChildren(
      ...voters.map(([playerId, choice]) => voterFor(playerId, choice, playerId === mine)),
    );
  }

  #statusLine(decision: number | null): string {
    const source = this.#source;
    if (decision !== null) {
      // ⚠️ **Le verdict se LIT** jusqu'a la disparition de la carte
      // (`#portalCloseTick`). `PORTAL_RESULT` porte un seul champ d'or dont le
      // sens se lit dans la decision : on ne l'affiche que s'il est ACQUIS.
      return decision === VOTE_CHOICE.LEAVE
        ? `L’équipe part — ${formatGold(source.portalGold)} or`
        : 'L’équipe reste';
    }
    // ⚠️ **Derive du TICK, jamais de l'horloge murale** : c'est le tick que le
    // serveur a date, donc le seul temps que les joueurs partagent.
    // `remainingSeconds` est celle du draft, importee plutot que recopiee.
    const seconds = remainingSeconds(source.portalDeadlineTick, source.hordeTick);
    return `Portail — ${seconds} s`;
  }
}

/**
 * Un votant : une pastille a la couleur du joueur, son numero, et **ce qu'il a
 * decide en un mot court**.
 *
 * ⚠️ **Le mot, pas seulement la couleur** : sinon « pas encore vote » et
 * « reste » se ressembleraient. La pastille creuse (CSS, `data-choice="none"`)
 * le redit.
 */
function voterFor(playerId: number, choice: number, isLocal: boolean): HTMLElement {
  const voter = document.createElement('span');
  voter.className = 'portal-voter';
  voter.dataset.player = `${playerId}`;
  voter.dataset.choice = voteState(choice);
  voter.dataset.local = isLocal ? 'true' : 'false';
  voter.style.borderColor = playerColor(playerId);

  const badge = document.createElement('i');
  badge.className = 'portal-voter__badge';
  badge.style.background = playerColor(playerId);
  badge.textContent = `${playerId}`;

  const label = document.createElement('b');
  label.className = 'portal-voter__label';
  label.textContent = voteLabel(choice);

  voter.append(badge, label);
  return voter;
}
```

- [ ] **Étape 4 : le HTML, le style, le câblage**

`front/index.html` : remplacer **toute** la section `#portal-layer` et le commentaire qui la précède
(l.587-605, de `<!--` « Vote d'extraction. ⚠️ **Ce n'est pas un modale** » jusqu'au `</section>`
qui ferme `#portal-layer`) par :

```html
      <!--
        Vote d'extraction (etape 17). Le portail GELE le monde, comme l'etalage :
        une carte compacte au centre, sur un voile leger. Le voile ne capte pas
        le pointeur ; seule la carte le reprend.
      -->
      <section id="portal-layer" class="ui-screen ui-screen--overlay z-20">
        <div
          id="portal"
          data-settled="false"
          class="veil pointer-events-none absolute inset-0 hidden"
        >
          <div class="ui-canvas">
            <div
              class="k k-paperx pointer-events-auto absolute left-1/2 top-1/2 flex w-[520px] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-[14px] text-center"
            >
              <p
                id="portal-status"
                aria-live="polite"
                class="f-meta m-0 text-[30px] text-[var(--color-slate-title)]"
              ></p>
              <div id="portal-choices" class="flex justify-center gap-[20px]"></div>
              <div id="portal-voters" class="flex flex-wrap justify-center gap-[12px]"></div>
            </div>
          </div>
        </div>
      </section>
```

`front/src/styles/main.css` : remplacer le bloc qui va du commentaire
`/* --- Vote d'extraction (bandeau, ne gele rien) -------------------------- */` jusqu'à la règle
`.portal-voter__badge { … }` incluse (l.1320-1348) par :

```css
  /* --- Vote d'extraction (etape 17 : une carte au centre, le monde gele) --- */

  /* Un voile LEGER, plus clair que celui de l'etalage : le monde gele reste
     lisible derriere la carte. */
  #portal.veil {
    background: rgb(18 14 16 / 0.35);
  }

  .portal-option {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 200px;
  }

  .portal-choice[data-mine="true"] {
    filter: brightness(1.15);
  }

  .portal-choice__key {
    margin-left: 10px;
    font-family: inherit;
    opacity: 0.75;
  }

  .portal-option__gold {
    font-size: 32px;
  }

  .portal-option__note {
    font-size: 16px;
    color: var(--color-slate-soft);
  }

  .portal-voter {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 10px 2px 2px;
    border: 3px solid;
    border-radius: 999px;
    font-size: 18px;
  }

  /* Pas encore vote : une pastille CREUSE, distincte de « reste » sans lire le mot. */
  .portal-voter[data-choice="none"] {
    border-style: dashed;
    opacity: 0.7;
  }

  .portal-voter__badge {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    font-family: var(--font-jer);
    font-size: 18px;
    font-style: normal;
    color: var(--color-outline);
  }
```

(les trois règles `.portal-voter[data-choice="none"|"leave"|"stay"] .portal-voter__label`
l.1350-1361 restent telles quelles).

`front/src/main.ts`, l.656-665 : remplacer

```ts
  // Le vote d'extraction. Un BANDEAU, pas un modale : le monde ne s'arrete
  // pas pendant qu'on vote (voir `ui/portal.ts`).
  const portalScreen = new PortalScreen(
    el('portal'),
    el('portal-status'),
    el('portal-stakes'),
    el('portal-choices'),
    el('portal-voters'),
    client,
  );
```

par

```ts
  // Le vote d'extraction : une carte au centre, le monde gele (etape 17, voir
  // `ui/portal.ts`).
  const portalScreen = new PortalScreen(
    el('portal'),
    el('portal-status'),
    el('portal-choices'),
    el('portal-voters'),
    client,
  );
```

`front/src/main.ts`, `setPaused` (l.479-485, posé par la passe interfaces) : après
`el('draft').toggleAttribute('inert', value);`, ajouter

```ts
    // Etape 17 : la carte du portail reprend le pointeur ; sous le menu Echap,
    // ses boutons ne doivent pas non plus repondre a Tab/Entree.
    el('portal-layer').toggleAttribute('inert', value);
```

(le `RUN_OVER`, l.499-501, rend déjà `#portal-layer` inerte : rien à y ajouter.)

- [ ] **Étape 5 : les relancer, ils passent**

Run : `cd front && npx vitest run src/ui/portal.test.ts src/main.test.ts && npx tsc --noEmit -p .`
Attendu : PASS, et le typecheck du front propre (`main.ts` construit `PortalScreen` avec quatre
éléments ; plus aucun `stakeLines` / `formatMultiplier`).

- [ ] **Étape 6 : commit**

```bash
npx biome check --write front/src/ui/portal.ts front/src/ui/portal.test.ts front/index.html front/src/styles/main.css front/src/main.ts
git add front/src/ui/portal.ts front/src/ui/portal.test.ts front/index.html front/src/styles/main.css front/src/main.ts
git commit -m "feat(front): le portail en carte compacte, un montant par bouton"
```

---

### Tâche 4 : les touches 1 et 2

**Fichiers :**
- Modifier : `front/src/ui/portal.ts` (une fonction exportée après `stayGold`, une méthode publique
  après `update`), `front/src/main.ts` (un écouteur `keydown` juste après la construction de
  `portalScreen`, l.~665 ; l'import l.45)
- Tester : `front/src/ui/portal.test.ts`

**Interfaces :**
- Consomme (tâche 3) : `PortalScreen` à quatre éléments, `#onVote(choice)` (règle du second clic).
- Produit : `export function portalKeyChoice(code: string, blocked: boolean): number | null` —
  `Digit1` / `Numpad1` → `VOTE_CHOICE.LEAVE`, `Digit2` / `Numpad2` → `VOTE_CHOICE.STAY`, `null`
  sinon ou si `blocked` ; `PortalScreen#vote(choice: number): void` — même règle que le clic, inerte
  si `!portalOpen` ou `portalDecision !== null`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/ui/portal.test.ts` : ajouter `portalKeyChoice` à l'import de `./portal`. En fin de
fichier :

```ts
describe('portalKeyChoice — 1 part, 2 reste (etape 17)', () => {
  it('lit le CODE physique : rangee du haut et pave numerique, AZERTY compris', () => {
    // `e.code`, pas `e.key` : en AZERTY, la touche 1 sans majuscule donne « & ».
    expect(portalKeyChoice('Digit1', false)).toBe(VOTE_CHOICE.LEAVE);
    expect(portalKeyChoice('Numpad1', false)).toBe(VOTE_CHOICE.LEAVE);
    expect(portalKeyChoice('Digit2', false)).toBe(VOTE_CHOICE.STAY);
    expect(portalKeyChoice('Numpad2', false)).toBe(VOTE_CHOICE.STAY);
  });

  it('ignore toute autre touche', () => {
    for (const code of ['Digit3', 'Numpad0', 'KeyA', 'Space', 'Escape', 'Enter']) {
      expect(portalKeyChoice(code, false)).toBeNull();
    }
  });

  /**
   * ⚠️ **Menu Echap ouvert, bilan affiche, HUD cache, touche tenue** :
   * `main.ts` le dit par `blocked`, et rien ne part.
   */
  it('ne rend rien quand les entrees sont bloquees', () => {
    expect(portalKeyChoice('Digit1', true)).toBeNull();
    expect(portalKeyChoice('Numpad2', true)).toBeNull();
  });
});

describe('PortalScreen#vote — le clavier suit la regle du clic', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('vote, puis RETIRE sa voix sur la meme touche', () => {
    ouvert(h);
    h.screen.update();
    h.screen.vote(VOTE_CHOICE.LEAVE);
    // Le serveur rediffuse : c'est lui qui dit ce que j'ai vote.
    h.client.votes([[2, VOTE_CHOICE.LEAVE]]);
    h.screen.update();
    h.screen.vote(VOTE_CHOICE.LEAVE);

    expect(h.client.sent).toEqual([VOTE_CHOICE.LEAVE, NO_VOTE]);
  });

  it('change de voix sur l AUTRE touche', () => {
    ouvert(h);
    h.client.votes([[2, VOTE_CHOICE.LEAVE]]);
    h.screen.update();
    h.screen.vote(VOTE_CHOICE.STAY);

    expect(h.client.sent).toEqual([VOTE_CHOICE.STAY]);
  });

  it('est inerte une fois le verdict tombe (la rampe de reprise comprise)', () => {
    ouvert(h);
    h.client.portalDecision = VOTE_CHOICE.STAY;
    h.screen.update();
    h.screen.vote(VOTE_CHOICE.LEAVE);

    expect(h.client.sent).toEqual([]);
  });

  it('est inerte sans portail ouvert', () => {
    h.screen.update();
    h.screen.vote(VOTE_CHOICE.STAY);

    expect(h.client.sent).toEqual([]);
  });
});
```

- [ ] **Étape 2 : les lancer, ils échouent**

Run : `cd front && npx vitest run src/ui/portal.test.ts`
Attendu : FAIL — `portalKeyChoice` n'est pas exporté, `h.screen.vote` n'existe pas.

- [ ] **Étape 3 : la fonction, la méthode, l'écouteur**

`front/src/ui/portal.ts`, après `stayGold` :

```ts
/**
 * La touche d'un vote : `1` part, `2` reste — rangee du haut ou pave
 * numerique, lus sur `KeyboardEvent.code` (la touche PHYSIQUE : en AZERTY, `1`
 * sans majuscule donne « & »). `null` pour toute autre touche.
 *
 * ⚠️ **`blocked` vient de `main.ts`** : menu Echap ouvert, bilan affiche, HUD
 * cache, ou touche tenue (`repeat`, qui ferait clignoter la voix). Il est
 * ICI, et pas seulement dans `main.ts`, pour qu'un test le tienne.
 */
export function portalKeyChoice(code: string, blocked: boolean): number | null {
  if (blocked) {
    return null;
  }
  if (code === 'Digit1' || code === 'Numpad1') {
    return VOTE_CHOICE.LEAVE;
  }
  if (code === 'Digit2' || code === 'Numpad2') {
    return VOTE_CHOICE.STAY;
  }
  return null;
}
```

Dans `PortalScreen`, après `update()` :

```ts
  /**
   * Vote au clavier (voir `portalKeyChoice`) : la MEME regle que le clic —
   * rappuyer sur la touche de sa voix la retire.
   *
   * ⚠️ **Inerte hors d'un vote ouvert et non tranche** : apres le verdict, le
   * portail est ferme au salon et un `VOTE` y serait refuse ; sans portail,
   * `1` et `2` ne veulent rien dire.
   */
  vote(choice: number): void {
    const source = this.#source;
    if (!source.portalOpen || source.portalDecision !== null) {
      return;
    }
    this.#onVote(choice);
  }
```

`front/src/main.ts` : l'import l.45 devient
`import { formatGold, PortalScreen, portalKeyChoice } from './ui/portal';` (Biome rangera). Juste
après la construction de `portalScreen` (la `);` qui ferme `new PortalScreen(…)`), ajouter :

```ts
  // Etape 17 : 1 part, 2 reste, tant que la carte est ouverte et non tranchee
  // (`PortalScreen#vote`) — jamais menu Echap ouvert, bilan affiche ou touche
  // tenue (`portalKeyChoice`).
  window.addEventListener('keydown', (e) => {
    const choice = portalKeyChoice(
      e.code,
      e.repeat ||
        paused ||
        hud.classList.contains('hidden') ||
        !summary.classList.contains('hidden'),
    );
    if (choice !== null) {
      portalScreen.vote(choice);
    }
  });
```

(`paused`, `hud` et `summary` sont ceux qu'emploie déjà l'écouteur `keydown` de la l.591, dans la
même fonction `join`.)

- [ ] **Étape 4 : les relancer, ils passent**

Run : `cd front && npx vitest run src/ui/portal.test.ts src/main.test.ts && npx tsc --noEmit -p .`
Attendu : PASS, typecheck propre.

- [ ] **Étape 5 : commit**

```bash
npx biome check --write front/src/ui/portal.ts front/src/ui/portal.test.ts front/src/main.ts
git add front/src/ui/portal.ts front/src/ui/portal.test.ts front/src/main.ts
git commit -m "feat(front): les touches 1 et 2 votent au portail"
```

---

### Tâche 5 : le livrable — deux sockets, un monde gelé, deux « rester »

**Fichiers :**
- Tester : `back/src/portal.integration.test.ts` (import des constantes l.2-7 ; un `describe` en fin
  de fichier)

**Interfaces :**
- Consomme (tâche 1) : le garde du portail dans `Room#step` ; `PORTAL_OPEN.deadlineTick = T +
  PORTAL_WINDOW_TICKS` ; `PORTAL_RESULT.effectTick = C < deadlineTick` dès que tous ont voté ;
  rampe de `LEVEL_RESUME_TICKS`. Les aides du fichier : `createRoomCode`, `connect`, `waitFor`,
  `viderSauf`, `poseCible`, `avancerJusqua`, `piloter`, `envoyer`, `positionDuFil`, `ouverturesDe`,
  `verdictsDe`, `DISTANCE_TEMOIN`, `TICKS_MESURE`, `DT`.
- Produit : rien.

- [ ] **Étape 1 : écrire le test**

`back/src/portal.integration.test.ts` : dans l'import de `@shared/constants` (l.2-7), ajouter
`LEVEL_RESUME_TICKS,` avant `PORTAL_WINDOW_TICKS,`. En fin de fichier :

```ts
describe('etape 17 : le portail gele le monde, sur deux sockets reelles', () => {
  /**
   * **Le livrable de l'etape 17.** Deux joueurs, un portail qui s'ouvre a son
   * rythme ; pendant le vote, les SNAPSHOT montrent un monde IMMOBILE alors que
   * les deux joueurs envoient « marcher a gauche » et qu'un monstre a une
   * cible ; deux « rester » ferment le portail AVANT l'echeance, et le monde
   * repart.
   *
   * ⚠️ **Le gel se lit sur le FIL** (positions des joueurs, or), et le temoin
   * dans le salon : un gel du seul client ne passerait pas.
   */
  it('les SNAPSHOT montrent un monde immobile, deux RESTER ferment le portail, le monde repart', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('le registre de salons doit etre accessible depuis l app');
    }
    const a = await connect(code);
    const b = await connect(code);
    const clients = [a, b];
    await waitFor(
      () => (a.lastSnapshot?.players.length === 2 ? true : null),
      'les deux joueurs dans le SNAPSHOT',
      3000,
    );

    // Le portail s'ouvre toutes les `PORTAL_EVERY_WAVES` vagues : on y va en
    // accelerant, horde videe, comme `tuerLeBoss`.
    await avancerJusqua(room, () => room.portalOpen, "l'ouverture du portail", 300 * TICK_HZ, () => {
      viderSauf(room, []);
    });
    const open = await waitFor(() => ouverturesDe(a)[0] ?? null, 'PORTAL_OPEN pour A', 15_000);
    await waitFor(() => ouverturesDe(b)[0] ?? null, 'PORTAL_OPEN pour B', 15_000);
    // Le premier tick gele, tel que le client le deduit (aucun octet de plus).
    const premierGele = open.deadlineTick - PORTAL_WINDOW_TICKS + 1;

    const ancre = positionDuFil(a);
    const temoin = poseCible(room, 9800, ancre.x + DISTANCE_TEMOIN, ancre.y);
    const posTemoin = (): { x: number; y: number } => {
      const slot = room.horde.slotOf(temoin);
      expect(slot).toBeGreaterThanOrEqual(0);
      return { x: room.horde.x[slot] ?? 0, y: room.horde.y[slot] ?? 0 };
    };
    const posDans = (s: SnapshotMessage, id: number): { x: number; y: number } => {
      const p = s.players.find((q) => q.id === id);
      if (!p) {
        throw new Error(`le joueur ${id} est absent du snapshot`);
      }
      return { x: p.x, y: p.y };
    };

    // Les deux « marchent a gauche » a l'horloge REELLE, pendant tout le test.
    const stopPilote = piloter(() => {
      viderSauf(room, [temoin]);
      const slot = room.horde.slotOf(temoin);
      if (slot >= 0) {
        room.horde.hp[slot] = 1e6;
      }
      for (const client of clients) {
        envoyer(client, -127, 0, 0, 0);
      }
    });

    try {
      // ---- 1. Le gel, sur le fil -------------------------------------------
      const reference = await waitFor(
        () => (a.lastSnapshot && a.lastSnapshot.tick >= premierGele ? a.lastSnapshot : null),
        'un SNAPSHOT du gel',
        5000,
      );
      const temoinAvant = posTemoin();
      await waitFor(
        () =>
          a.lastSnapshot && a.lastSnapshot.tick >= reference.tick + TICKS_MESURE ? true : null,
        'des SNAPSHOT pendant le gel',
        20_000,
      );
      const apres = a.lastSnapshot;
      if (!apres) {
        throw new Error('un SNAPSHOT attendu');
      }
      // Le tick avance (il date le verdict)...
      expect(apres.tick).toBeGreaterThanOrEqual(reference.tick + TICKS_MESURE);
      // ...rien d'autre : ni les joueurs, qui envoient pourtant leurs entrees,
      // ni la horde, ni l'or.
      for (const client of clients) {
        expect(posDans(apres, client.playerId), `le joueur ${client.playerId} bouge`).toEqual(
          posDans(reference, client.playerId),
        );
      }
      expect(posTemoin(), 'la horde bouge pendant le vote').toEqual(temoinAvant);
      expect(apres.gold).toBe(reference.gold);
      expect(room.portalOpen).toBe(true);
      expect(verdictsDe(a)).toHaveLength(0);

      // ---- 2. Deux « rester » ferment le portail AVANT l'echeance ----------
      for (const client of clients) {
        client.ws.send(encodeVote(VOTE_CHOICE.STAY));
      }
      const verdict = await waitFor(() => verdictsDe(a)[0] ?? null, 'PORTAL_RESULT pour A', 15_000);
      const verdictB = await waitFor(() => verdictsDe(b)[0] ?? null, 'PORTAL_RESULT pour B', 15_000);
      expect(verdictB).toEqual(verdict);
      expect(verdict.decision).toBe(VOTE_CHOICE.STAY);
      expect(verdict.effectTick).toBeLessThan(open.deadlineTick);

      // ---- 3. Et le monde repart, apres la rampe ---------------------------
      const repartie = verdict.effectTick + LEVEL_RESUME_TICKS + TICKS_MESURE;
      await waitFor(
        () => (a.lastSnapshot && a.lastSnapshot.tick >= repartie ? true : null),
        'des SNAPSHOT apres la reprise',
        20_000,
      );
      const fin = a.lastSnapshot;
      if (!fin) {
        throw new Error('un SNAPSHOT attendu');
      }
      // Un mouvement, pas une vitesse : ~130 px de rampe puis ~390 px a pleine
      // vitesse pour un joueur, ~70 px au moins pour le temoin.
      for (const client of clients) {
        expect(
          posDans(reference, client.playerId).x - posDans(fin, client.playerId).x,
          `le joueur ${client.playerId} reste fige apres le verdict`,
        ).toBeGreaterThan(100);
      }
      const temoinFin = posTemoin();
      expect(
        Math.hypot(temoinFin.x - temoinAvant.x, temoinFin.y - temoinAvant.y),
        'la horde reste figee apres le verdict',
      ).toBeGreaterThan(30);
    } finally {
      stopPilote();
    }
  }, 120_000);
});
```

- [ ] **Étape 2 : le lancer, il passe**

Run : `cd back && npx vitest run src/portal.integration.test.ts`
Attendu : PASS (3 / 3). Un échec isolé de compte ou d'or à 0 se relance **une fois** (base
partagée). Noter la durée du nouveau test.

- [ ] **Étape 3 : la contre-épreuve (puis annulée)**

Dans `back/src/room.ts`, commenter les quatre lignes du garde du portail en tête de `step` (le
`if (this.portalOpen) { this.#stepPortal(); return; }` de la tâche 1).

Run : `cd back && npx vitest run src/portal.integration.test.ts -t "etape 17"`
Attendu : FAIL — « le joueur … bouge » (ou « la horde bouge pendant le vote ») ; sans
`#stepPortal`, aucun verdict ne tomberait de toute façon. Noter le message d'échec exact pour le
bilan.

Rétablir le garde, puis : `git diff back/src/room.ts` → **vide**.

- [ ] **Étape 4 : commit**

```bash
npx biome check --write back/src/portal.integration.test.ts
git add back/src/portal.integration.test.ts
git commit -m "test(back): le livrable de l etape 17, le portail gele le monde sur vraies sockets"
```

---

### Tâche 6 : le portique et le bilan (contrôleur, seul)

**Fichiers :**
- Créer : `docs/plans/2026-11-06-etape-17-resultats.md`
- Modifier : `README.md` (une ligne après celle de l'étape 16, l.39)

**Interfaces :**
- Consomme : les tâches 1 à 5, commitées.
- Produit : le portique vert, le bilan ouvert, le README à jour, le graphe rafraîchi.

- [ ] **Étape 1 : le portique complet, rien d'autre en vol**

Run : `npm run lint && npm run typecheck && npm test`
Attendu : tout vert. Noter le nombre de tests front et back **de cette exécution seule**. Un échec
isolé de compte ou d'or à 0 dans un test d'intégration se relance **une fois** (base partagée).

Puis les bancs, seul aussi : `npm run bench` — noter `bench:sim` et `bench:net`. Aucun banc
n'ouvre de portail (vingt vagues) : ils mesurent que le garde de tête de `step` ne coûte rien au
chemin chaud (une lecture de `#portal.phase` par pas).

Puis la dérive du portail, seule : `cd front && npx vitest run src/net/client.test.ts -t "etape 17"`
— noter les deux lignes `[etape 17] portail a l heure / en retard` (**0,000 px** attendu) et la
ligne `[tache 10] gel : avant=…` (écart n° 1 : elle passe de 53,3 px à plusieurs centaines).

- [ ] **Étape 2 : mettre le graphe à jour**

Run : `graphify update .`

- [ ] **Étape 3 : écrire le bilan**

`docs/plans/2026-11-06-etape-17-resultats.md`, sur le modèle de
`docs/plans/2026-11-05-etape-16-resultats.md` — titre « Étape 17 — l'extraction qui gèle :
résultats », liens **Spec** et **Plan**, un paragraphe d'ouverture (le portail gèle le monde comme
l'étalage, une carte compacte de 520 px, les touches 1 / 2, aucun octet de plus), puis
« ⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur. » :

1. **Le livrable** — le test « etape 17 » de `back/src/portal.integration.test.ts` (deux sockets,
   monde immobile sur le fil, deux « rester » avant l'échéance, monde qui repart) et sa
   contre-épreuve (le message d'échec noté à la tâche 5) ; les deux tests existants inversés à la
   tâche 1.
2. **Ce qui est livré** — un tableau pièce / où : le garde du portail, le verbe refusé pendant le
   vote et la reprise (`back/src/room.ts`) ; le gel daté et rejoué, `freezeIsPortal`, l'étalage vidé
   (`front/src/net/client.ts`) ; le badge « Portail — pause… » (`front/src/ui/hud.ts`) ; la carte
   (`front/src/ui/portal.ts`, `front/index.html`, `front/src/styles/main.css`) ; les touches
   (`portalKeyChoice`, `PortalScreen#vote`, `front/src/main.ts`).
3. **Le coût sur le fil** — **aucun message nouveau, aucun octet de plus** : `PORTAL_OPEN`,
   `VOTES`, `PORTAL_RESULT`, `VOTE` inchangés ; le début du gel se déduit de
   `deadlineTick − PORTAL_WINDOW_TICKS + 1`, la fin d'`effectTick`.
4. **Écarts au plan et à la spec** — les neuf écarts assumés de ce plan, en une ligne chacun (le n° 1
   en premier : `LEVEL_UP` et `DRAFT_RESULT` sont désormais datés et rejoués aussi), plus ce que
   l'exécution aura changé.
5. **Le portique** — le tableau typecheck / tests front / tests back / lint, les bancs, les deux
   dérives du portail.
6. **Vérification manuelle — ouverte**, les points du §7 de la spec :
   - la carte se lit-elle d'un coup d'œil, sans masquer le jeu au point de perdre le fil ?
   - 1 / 2 au clavier : naturel, ou en conflit avec un autre geste ?
   - la reprise après « rester » est-elle confortable ?

   Plus les risques du §6 de la spec à surveiller : un joueur qui rejoint pendant le portail ne
   sait pas que le monde est gelé ; un absent bloque l'équipe jusqu'à 20 s (réglage d'une ligne :
   `PORTAL_WINDOW_TICKS`) ; le portail n'est plus une source de tension. Et deux suites de la
   passe interfaces (`3c1b007`) : `Room#useAbility`, qui agit hors de `step`, refusait déjà les
   verbes pendant un étalage et le gel — l'étape 17 y ajoute le vote du portail ; le point 6 de
   son §3 (« Extraction réussie + 0 » quand effacement et « partir » tombent au même tick) est
   refermé, le vote ne tournant plus qu'à monde gelé.

- [ ] **Étape 4 : le README**

Après la ligne de l'étape 16 (`README.md` l.39), ajouter :

```markdown
| 17 | L'extraction qui gèle : le portail met le monde en pause, une carte compacte, touches 1 / 2 — **zéro octet de plus** | 📝 — [spec](docs/specs/2026-11-06-etape-17-extraction.md) · [plan](docs/plans/2026-11-06-etape-17-extraction.md) · [résultats](docs/plans/2026-11-06-etape-17-resultats.md) |
```

- [ ] **Étape 5 : commit**

```bash
git add docs/plans/2026-11-06-etape-17-resultats.md README.md
git commit -m "docs: le bilan de l etape 17 (verification manuelle ouverte)"
```

---

## Auto-revue

**Couverture de la spec.**
- §1 le gel au serveur (garde avant l'étalage, `#stepPortal` retiré de la fin, rien ne bouge, tick
  qui compte, `T + 1` premier gelé, reprise après « rester », « partir » termine, aucun verbe
  pendant le vote) → tâche 1 ;
  au client (début `deadlineTick − PORTAL_WINDOW_TICKS + 1`, fin `effectTick`, `isFrozen`, roue de
  ping fermée par `canOpen`) → tâche 2, avec l'écart n° 1 (le rejeu que la spec croyait exister).
- §2 portail et étalage → tâche 1 (étalage dû qui attend, « partir » qui l'abandonne).
- §3 la carte (520 px, voile léger qui ne capte pas le pointeur, titre et chrono, verdict, deux
  boutons et leurs montants, « si l'équipe tient », `data-mine`, pastilles à trois états,
  `stakeLines` retiré) → tâche 3 ; touches `Digit1/2`, `Numpad1/2`, retrait sur la même touche,
  inertes menu Échap / bilan / tranché → tâche 4.
- §4 ce qui ne change pas → contraintes globales ; commentaires réécrits → tâches 1 (back,
  `shared/constants.ts`, `server.ts`) et 3 (`index.html`, `portal.ts`, `main.ts`).
- §5 tests : salon → tâche 1 ; réplication 0,000 px avec `PORTAL_OPEN` en retard → tâche 2 ; client
  → tâche 2 ; écran et touches → tâches 3 et 4 ; livrable et contre-épreuve → tâche 5.
- §6 risques, §7 vérification manuelle → tâche 6 (bilan).

**Espaces réservés.** Aucun « TBD » ; chaque étape de code porte son code ; les tests existants
modifiés sont cités par titre et par ligne.

**Cohérence des noms.** `#freezeFrom(startTick, portal)`, `#thawAt(endTick)`,
`#replayFrom(fromTick)`, `#untilAt(tick)`, `freezeIsPortal` (tâche 2, lu par `hud.ts` tâche 2) ;
`PortalScreen(root, status, choices, voters, source)` (tâche 3, appelé par `main.ts` tâche 3) ;
`portalKeyChoice(code, blocked)` et `PortalScreen#vote(choice)` (tâche 4) ; `goldText`, `posDans`
locaux aux tests.
