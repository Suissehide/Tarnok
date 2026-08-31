# Étape 6a — la run a une fin : plan d'implémentation

> **Pour un agent exécutant :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour
> exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** une run s'organise en paliers de 4 vagues + 1 boss, la difficulté est une formule, l'or
ramassé n'est acquis qu'à l'extraction, et un vote de 20 s décide de continuer ou de partir.

**Architecture :** le boss vit **dans** la horde et réutilise tout ce que quatre étapes ont
construit ; seule sa vie voyage, parce qu'il est **un**. Le vote reprend la forme du draft — une
ouverture datée, des intentions rediffusées, une résolution annoncée — **sans le gel**, parce que le
temps est son enjeu.

**Pile :** TypeScript strict, workspaces npm, Vitest, PixiJS v8, Biome.

**Spec :** [`../specs/2026-09-01-etape-6a-paliers.md`](../specs/2026-09-01-etape-6a-paliers.md)

---

## Contraintes globales

Chaque tâche les respecte, sans les répéter.

- **Porte de commit** : `npm run lint`, `npm run typecheck`, `npx vitest run --root back`,
  `npx vitest run --root front`, `npm run build --workspace front` — tous verts **avant** de
  commiter, et on lit le **verdict**, jamais la fin de la sortie. Deux commits sont déjà partis avec
  le lint rouge dans ce dépôt pour cette raison exacte.
- **Mutation testing** : appliquer la mutation **sur le disque**, relancer, vérifier qu'elle rougit,
  restaurer. Base verte vérifiée **avant chaque lot**, et chaque motif présent **exactement une
  fois** avant application — sans ça on récolte des faux positifs (une mutation « attrapée » parce
  qu'un test intermittent rougissait) et des faux négatifs (une mutation qui ne met pas en scène ce
  qu'elle prétend tester).
- **Quand une mutation survit, chercher d'abord si une AUTRE garde la masque**, avant d'écrire un
  test. **Quinze occurrences** dans ce projet ; plusieurs soldées par une **suppression de code**.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : l'auteur joue sur les ports 5173 et 3100.
- Aucun asset au dépôt — licence Tiny Swords, dépôt public. Les textures se génèrent en code.
- Commits : sujet en minuscules, en français, type parmi
  `build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test`. Utiliser `git commit -F -` avec un
  heredoc **quoté** : les backticks dans un `-m` entre guillemets doubles sont interprétés.
- `shared/` interdit `Math.random` et `Date.now` : tout ce qui y vit tourne des deux côtés du fil.
- **Si le plan ou la spec se contredit, le signaler — ne pas choisir en silence.** Les documents de
  ce projet se sont trompés **vingt-huit fois** à l'étape 5a, dont une contradiction dure qu'un
  implémenteur a refusé d'écrire, et une règle que la mesure a inversée.

---

## Cohérence des constantes

> Ce tableau a évité plusieurs défauts et en a causé trois : `SEPARATION_STRENGTH` y était donnée
> comme sans effet sur le coût, alors qu'elle en était le principal levier ; il ne désignait que
> `ZONE_RADIUS` comme levier de coût des zones alors que la cadence des armes en était un aussi ; et
> il ne disait pas que `ZONE_RADIUS` servait **aussi** de rayon de fusion. **Il ne protège que si les
> contraintes qu'on y écrit sont les bonnes.**

| Constante | Valeur | Contrainte |
| --- | --- | --- |
| `WAVES_PER_PALIER` | **4** | §9.1. Avec une vague toutes les 180 ticks, un palier dure ≥ 24 s **plus** le temps de tuer le boss |
| `PORTAL_WINDOW_TICKS` | **600** (20 s) | §9.3. ⚠️ **Même nombre que `DRAFT_WINDOW_TICKS`, pour une raison différente** — ne pas les dériver l'une de l'autre, elles bougeront séparément |
| `PALIER_COUNT_SCALE` | **0,15** | §9.2, `×(1 + 0,15 k)`. ⚠️ Multiplie `waveCountBounds`, qui plafonne déjà à `MAX_ENTITIES` |
| `PALIER_HP_SCALE` | **1,12** | §9.2, `×1,12^k`. ⚠️ **Divise le rythme de mise à mort**, déjà à −12,8 % depuis l'étape 5a |
| `BOSS_HP_BASE` | **à mesurer, tâche 3** | la porte du §7 : le boss doit mourir en 30 à 90 s au palier 0 |
| `BOSS_BODY_SCALE` | **~3** | il doit se lire dans la mêlée. ⚠️ `BODY_SCALE` vaut 1,25 pour la piétaille et est plafonné à 1,28 **par un test** — le boss a besoin de son propre facteur, pas d'un relèvement du plafond commun |
| `WIPE_GOLD_KEPT` | **0** | ⚠️ **LE paramètre du §9.3.** Décision de l'auteur : 100 % perdu. Il doit rester une constante lisible : les deux alternatives (plancher de 10-20 %, bonus de palier toujours payé) doivent s'essayer **sans refonte** |
| `EXTRACT_MULTIPLIER_STEP` | **0,25** | ce que « rester » ajoute au multiplicateur. Trop plat, rester ne se justifie pas ; trop raide, partir tôt devient absurde |
| `GOLD_PER_PALIER_BASE` | **à régler** | croissant avec `k` (§9.2) |

> ⚠️ **`PALIER_HP_SCALE` et `PALIER_COUNT_SCALE` ne sont pas des réglages de sensation : ce sont la
> durée de vie du jeu.** Une table s'épuise en trois soirées ; une formule ne s'épuise pas mais peut
> diverger. **Les deux sens comptent** — trop plate, la run n'a pas de fin ; trop raide, le palier 8
> est un mur. La tâche 3 les mesure sur dix paliers **sans jouer**.

---

## Structure des fichiers

| Fichier | Responsabilité |
| --- | --- |
| `shared/paliers.ts` | **créer** — les formules du §9.2, pures, lues des deux côtés |
| `shared/archetypes.ts` | + l'archétype du boss |
| `shared/protocol.ts` | + la vie du boss, `PORTAL_OPEN`, `VOTE`, `VOTES`, `PORTAL_RESULT` |
| `back/src/wave-director.ts` | la structure en paliers, l'échelle par palier |
| `back/src/portal.ts` | **créer** — la machine du vote, testable sans serveur, calquée sur `draft.ts` |
| `back/src/room.ts` | intègre le palier, le boss, l'or et le portail au tick |
| `front/src/net/client.ts` | reçoit la vie du boss et le vote |
| `front/src/ui/portal.ts` | **créer** — l'écran du vote |
| `front/src/render/` | la barre de vie du boss |

---

## Tâche 1 : les formules du palier

**Fichiers :** créer `shared/paliers.ts`, `shared/paliers.test.ts` ; modifier `shared/constants.ts`

**Interfaces :**
- Produit : `waveCountScale(k)`, `hpScale(k)`, `palierGold(k)` — **pures**, lues des deux côtés.

- [ ] **Étape 1 : trois fonctions, aucune classe.** Elles ne portent pas d'état : le palier courant
  est une donnée du salon, pas de la formule.

- [ ] **Étape 2 : le test qui compte, et il a deux moitiés.** Une formule doit **croître** —
  vérifier `f(k+1) > f(k)` sur dix paliers — **et** rendre exactement 1 (ou la base) à `k = 0`.

  ⚠️ **Sans la seconde moitié, une formule qui croît trop vite passe.** Sans la première, une
  constante passe. Ce dépôt a trouvé neuf décors qui ne séparaient pas les deux cas.

- [ ] **Étape 3 : la divergence est un test, pas un espoir.** Au palier 10, `waveCountScale`
  multiplie une vague déjà plafonnée par `waveCountBounds`. Le test dit ce qui se passe : soit le
  plafond tient, soit il faut le dire.

- [ ] **Étape 4 : commit** — `feat(shared): les formules de palier`

---

## Tâche 2 : le palier structure la run

**Fichiers :** modifier `back/src/wave-director.ts`, `back/src/room.ts`, leurs tests

- [ ] **Étape 1 : le directeur compte ses vagues.** Après `WAVES_PER_PALIER`, il n'émet plus de
  vague ordinaire mais **demande un boss**.

- [ ] **Étape 2 : le palier se termine à la MORT DU BOSS, pas à un tick.** C'est ce qui rend le
  rythme élastique — une équipe qui peine reste plus longtemps, une équipe qui domine avance.

  ⚠️ **Le salon sait déjà quand une entité meurt** (`DEATHS`). Ne pas inventer un second chemin de
  mort : le rejeu de l'étape 3 en dépend, et l'étape 5a a déjà fusionné les morts par brûlure et par
  réaction dans **le lot unique du tick**.

- [ ] **Étape 3 : les vagues ne s'arrêtent pas pendant le boss** (§2 de la spec). Le test le dit
  explicitement, sinon quelqu'un « corrigera » ça un jour en croyant bien faire.

- [ ] **Étape 4 : l'échelle s'applique.** `waveCountScale(k)` multiplie le compte, `hpScale(k)` les
  points de vie à l'apparition.

  ⚠️ **Les PV de départ voyagent déjà** : l'archétype est dans l'ordre de vague de 19 octets. **Le
  palier doit y voyager aussi, ou être dérivable** — sinon les deux côtés ne calculent pas les mêmes
  PV, et le client tue des monstres que le serveur garde. **À trancher et à écrire.**

- [ ] **Étape 5 : commit** — `feat(back): la run s'organise en paliers`

---

## Tâche 3 : le boss — **et la porte**

**Fichiers :** modifier `shared/archetypes.ts`, `back/src/wave-director.ts`, leurs tests ; créer un banc

- [ ] **Étape 1 : un archétype de boss.** PV élevés, corps plus grand.

  ⚠️ **`BODY_SCALE` vaut 1,25 et est plafonné à 1,28 par un test** qui dit qu'au-delà la hitbox ment
  trop. Le boss a besoin de son **propre** facteur — ne relève pas le plafond commun, il garde autre
  chose.

- [ ] **Étape 2 : il apparaît comme une vague de `count: 1`.** Identité arithmétique, champ de flux,
  séparation, collision, orbes, marques élémentaires : **tout est déjà là**. N'écris rien de
  nouveau ; vérifie que tout marche.

  ⚠️ **C'est le premier ennemi qui survivra assez longtemps pour qu'une réaction se voie sur lui.**
  Un test devrait le montrer.

- [ ] **Étape 3 : LA PORTE.** Mesurer, sans jouer, combien de temps quatre joueurs mettent à tuer le
  boss au palier 0.

  **Trois issues, engagées AVANT la mesure** (§7 de la spec) :
  1. il meurt en **30 à 90 s** → **on garde** ;
  2. moins de **15 s** → **on monte `BOSS_HP_BASE`**, pas la formule ;
  3. plus de **3 min** → **on baisse `BOSS_HP_BASE`**, et on rouvre `PALIER_HP_SCALE`.

  ⚠️ **Un banc qui ne peut rien mesurer rend zéro et paraît vert.** L'étape 5a en a trouvé un qui
  peuplait de piétaille légère, tuée du même impact, donc jamais marquée : il rendait zéro partout.
  **Vérifie que ton décor produit ce qu'il prétend mesurer avant de croire son chiffre.**

- [ ] **Étape 4 : la divergence sur dix paliers**, sans jouer : effectif et PV totaux. Si le palier 8
  dépasse `MAX_ENTITIES`, c'est `waveCountBounds` qui plafonne — **le dire, pas le découvrir**.

- [ ] **Étape 5 : commit** — `feat: le boss verrouille le palier`, avec **le verdict de la porte dans
  le corps**, quel qu'il soit.

---

## Tâche 4 : la vie du boss voyage

**Fichiers :** modifier `shared/protocol.ts`, `back/src/room.ts`, leurs tests

- [ ] **Étape 1 : le snapshot porte le boss.** Son identité et ses points de vie, une fois par tick.

  ⚠️ **C'est la première donnée par entité que le fil transporte, et c'est le nombre qui l'autorise
  — un seul boss vivant.** Écris-le dans le code : le jour où un palier en fera dix, ce ne sera plus
  un boss mais de la piétaille d'élite, et sa vie redeviendra serveur seul.

  ⚠️ **`hp` du joueur est passé de `u8` à `u16` à l'étape 4** parce qu'à la huitième carte de
  vitalité un joueur se repliait silencieusement à 4 PV. Le boss a des **centaines** de fois les PV
  de la piétaille lourde et ils croissent en `1,12^k` : **choisis la largeur en la calculant**, et
  teste la borne.

- [ ] **Étape 2 : le cas « pas de boss ».** Une sentinelle qui ne peut pas valoir une identité
  réelle — le précédent est `NO_TOKEN = 255` à l'étape 4, choisi parce que la carte 0 est une carte
  réelle.

- [ ] **Étape 3 : les tests d'aller-retour**, avec une **assertion de taille en chiffre nu**, et
  `toThrow(/tronque/)` jamais `toThrow()` nu — un `RangeError` de `DataView` ferait passer un
  `toThrow()` nu même sans le contrôle de longueur.

- [ ] **Étape 4 : commit** — `feat(shared): la vie du boss sur le fil`

---

## Tâche 5 : la barre de vie

**Fichiers :** modifier `front/src/net/client.ts`, `front/src/render/`, `front/src/ui/hud.ts`, leurs tests

- [ ] **Étape 1 : la seule barre de vie du jeu.** Ni la piétaille ni les joueurs n'en ont — c'est ce
  qui la rend lisible.

  **Décision de l'auteur : une PETITE barre, AU-DESSUS du boss**, qui le suit. Pas un bandeau de
  HUD : elle appartient à la créature, pas à l'écran.

  Le pack fournit ce qu'il faut : `assets/tinyswords/UI Elements/UI Elements/Bars/SmallBar_Base.png`
  et `SmallBar_Fill.png`.

  ⚠️ **CES FICHIERS NE DOIVENT JAMAIS ENTRER DANS LE DÉPÔT.** La licence Pixel Frog interdit la
  redistribution **même après modification**, ce dépôt est **public**, et la CI échoue sur
  `git ls-files | grep '^assets/tinyswords'` — *« une fois committés, les retirer demande une
  réécriture, donc on échoue ici plutôt que là »*.

  Le chemin est celui des atlas de monstres : `assets/tinyswords/` est **gitignoré**, un outil de
  `tools/` produit un dérivé, et le dérivé vit sur **MinIO**, pas dans git. Lire
  `tools/build_monster_atlas.py` et `tools/fetch-assets.sh` avant d'écrire quoi que ce soit.

  **Si le chemin MinIO n'est pas praticable dans la tâche, dessiner la barre en code** — comme
  `makeGlowTexture`, `makeZoneTexture`, `makeRingTexture` et l'atlas de projectiles de l'étape 5a le
  font déjà. **Ne jamais committer l'asset « en attendant ».**

- [ ] **Étape 2 : elle suit le boss et disparaît avec lui.** Le client apprend sa mort par `DEATHS`,
  comme pour tout le monde.

  ⚠️ **Elle se pose AU-DESSUS du corps, donc au-dessus de la moitié haute du sprite** — et l'ancre
  du corps a changé à l'étape 5a : `BODY_ANCHOR_Y` vaut désormais **0,5**, le corps est centré sur
  la position. Le décalage se dérive de la taille dessinée, jamais d'un nombre écrit à la main.

- [ ] **Étape 3 : le test.** ⚠️ **La boucle de rendu est testable depuis l'étape 5a**
  (`front/src/render/frame.ts`) : une mutation qui retire un appel de dessin doit rougir. **Vérifie-le
  avant de commiter** — c'est ce qui a soldé une dette vieille de trois étapes.

- [ ] **Étape 4 : commit** — `feat(front): la barre de vie du boss`

---

## Tâche 6 : l'or non sécurisé

**Fichiers :** modifier `back/src/room.ts`, `shared/protocol.ts`, leurs tests

- [ ] **Étape 1 : l'or est une donnée d'ÉQUIPE**, un seul nombre, comme l'expérience et la Synergie.

  ⚠️ **L'étape 3 a fait l'erreur inverse** avec l'expérience — une par joueur *et* une d'équipe, donc
  deux sources de vérité pour un seul nombre — et l'implémenteur l'avait signalée.

- [ ] **Étape 2 : le bonus de palier** à la mort du boss, croissant avec `k`.

- [ ] **Étape 3 : la perte, et c'est LE paramètre.** `WIPE_GOLD_KEPT = 0` : l'effacement de l'équipe
  fait tout perdre.

  ⚠️ **Une constante lisible, jamais un `0` en dur dans une branche.** Le §9.3 appelle cette ligne
  *« le principal risque de design de tout le document »* et nomme deux alternatives à pouvoir
  essayer **sans refonte** : un plancher de 10-20 %, ou le bonus de palier toujours payé.

- [ ] **Étape 4 : le test a DEUX moitiés.** L'or monte quand un boss tombe, **et** il tombe à
  `WIPE_GOLD_KEPT` quand l'équipe est effacée. **Sans la seconde, un or qui ne bouge jamais passe.**

- [ ] **Étape 5 : commit** — `feat(back): l'or non securise`

---

## Tâche 7 : le protocole du vote

**Fichiers :** modifier `shared/protocol.ts`, `shared/protocol.test.ts`

- [ ] **Étape 1 : quatre messages, calqués sur le draft.** `PORTAL_OPEN` (échéance), `VOTE` (C → S),
  `VOTES` (S → C, qui a voté quoi), `PORTAL_RESULT` (la décision, l'or acquis ou reporté).

  ⚠️ **Le draft a appris trois choses à ne pas refaire** : le message de résultat doit porter **le
  tick d'effet** (le client ne peut rien déduire) ; une **sentinelle** de « pas de vote » ne peut pas
  valoir une valeur réelle ; et un champ qui décrit ce que le serveur *compare* n'a pas à voyager —
  seul son **verdict** voyage.

- [ ] **Étape 2 : le total de l'or dans le `SNAPSHOT`**, à côté de l'expérience et de la Synergie.

- [ ] **Étape 3 : commit** — `feat(shared): le protocole du vote d'extraction`

---

## Tâche 8 : la machine du vote

**Fichiers :** créer `back/src/portal.ts`, `back/src/portal.test.ts`

- [ ] **Étape 1 : calquer `back/src/draft.ts`.** Il est éprouvé : ouverture datée, intentions,
  résolution, absents servis d'office, et il **ne connaît ni `ws` ni `Room`**.

- [ ] **Étape 2 : la règle.** Majorité ; **égalité = on continue** (§9.3). Tout joueur connecté vote,
  **mort ou vif** — la mort d'un seul ne coûte rien, donc elle ne coûte pas la voix non plus.

- [ ] **Étape 3 : l'absence ne bloque jamais.** À l'échéance, on tranche avec ce qu'on a. Le §4.4 de
  l'étape 4 a déjà établi la règle pour le draft.

- [ ] **Étape 4 : les tests.** ⚠️ **Le décor doit produire le cas qu'il prétend créer.** Ce dépôt a
  trouvé neuf fixtures qui rendaient une mutation invisible : un seul perdant là où il en fallait
  deux, des joueurs qui avaient tous une carte réservée, deux zones alignées. **Compte l'égalité que
  tu crois créer.**

- [ ] **Étape 5 : commit** — `feat(back): la machine du vote d'extraction`

---

## Tâche 9 : le portail s'ouvre à la mort du boss

**Fichiers :** modifier `back/src/room.ts`, `back/src/server.ts`, leurs tests

- [ ] **Étape 1 : le boss meurt, le portail s'ouvre.** Vingt secondes.

- [ ] **Étape 2 : LE MONDE NE S'ARRÊTE PAS.**

  ⚠️ **C'est la différence structurante avec le draft, et le réflexe inverse est fort** : la
  machinerie du gel est là, prête, et elle marche. Le §9.3 dit *« pendant que la vague suivante
  approche »* — c'est la vague qui met la pression. **Le draft gèle parce qu'un choix de carte n'a
  pas d'enjeu temporel ; le vote ne gèle pas parce que le temps EST son enjeu.**

  Un test doit l'assener : la horde avance pendant le vote.

- [ ] **Étape 3 : partir termine la run.** `RUN_OVER` existe depuis l'étape 3 — le réutiliser, avec
  l'or acquis. **Ne pas inventer une seconde fin de run.**

- [ ] **Étape 4 : rester ouvre le palier suivant**, multiplicateur augmenté.

- [ ] **Étape 5 : diffusion**, dans l'ordre déjà établi : les messages du portail partent **avant le
  snapshot du même tick**, comme les ordres de vague, les morts et le draft.

- [ ] **Étape 6 : commit** — `feat(back): le portail s'ouvre a la mort du boss`

---

## Tâche 10 : le client reçoit le vote, et l'écran

**Fichiers :** modifier `front/src/net/client.ts` ; créer `front/src/ui/portal.ts` ; leurs tests

- [ ] **Étape 1 : recevoir et exposer.** Le client ne **décide** rien — le serveur arbitre.

- [ ] **Étape 2 : les votes des autres sont VISIBLES, en continu.** Le §7.2 de l'étape 4 l'a établi
  pour les jetons : *« sans cette visibilité, la mécanique n'existe pas »*. Ici c'est plus vrai
  encore — on ne négocie pas un choix qu'on ne voit pas.

- [ ] **Étape 3 : le chronomètre**, et l'or en jeu — ce qu'on gagne en partant, ce qu'on risque en
  restant. **Un vote dont on ne voit pas l'enjeu n'est pas un vote.**

- [ ] **Étape 4 : les tests sous jsdom**, `front/src/ui/draft.test.ts` est le modèle. Et la
  non-régression de la boucle de rendu.

- [ ] **Étape 5 : commit** — `feat(front): l'ecran du vote d'extraction`

---

## Tâche 11 : quatre clients, en headless — **le livrable du §13**

**Fichiers :** créer ou étendre un test d'intégration dans `back/`

- [ ] **Étape 1 : le harnais existe** — `back/src/draft.integration.test.ts` et
  `elements.integration.test.ts`. Quatre vraies sockets, `app.rooms`, `buildServer({ roomSeed })`,
  monstres posés à la main. **Réutiliser, ne pas réinventer.**

- [ ] **Étape 2 : ce que le test doit assener :**
  - un palier **se termine** — le boss meurt ;
  - le portail **s'ouvre**, et les votes se **voient** ;
  - la majorité tranche, **et l'égalité continue** ;
  - **l'or bouge dans les DEUX sens** : acquis en partant, perdu à l'effacement ;
  - la horde **avance pendant le vote** ;
  - les **trois chiffres de réplication restent à 0,000 px**.

  ⚠️ **« L'or est acquis quand on part » se lit aussi bien avec un or qui ne bouge jamais.** Il faut
  partir **et** être effacé. C'est la leçon de la Synergie à l'étape 5a : la moitié négative porte le
  sens.

- [ ] **Étape 3 : commit** — `test(back): un palier se termine et le vote engage l'or`

---

## Tâche 12 : vérification manuelle et clôture

- [ ] **Jouer une run entière, au premier plan.** `window.__tarnok` permet d'avancer les images à la
  main si besoin.

- [ ] **Ce qui relève du jugement**, et que rien n'automatise :
  - **vingt secondes, est-ce assez** pour décider à quatre ?
  - la perte totale se **vit**-elle comme une tension ou comme une punition ? C'est la question que
    le §9.3 désigne comme la plus risquée du projet ;
  - un boss qui n'a que des points de vie **se sent**-il comme un boss ?
  - le palier 3 ou 4 est-il encore jouable, ou la formule a-t-elle divergé ?

- [ ] **Rejouer les bancs** — les PV par palier changent le rythme de mise à mort, le boss change le
  coût du tick.

- [ ] Écrire `docs/plans/2026-09-01-etape-6a-resultats.md` et mettre à jour le `README.md`.

- [ ] **Commit** — `docs: resultats de l'etape 6a`

---

## Auto-relecture

**Couverture de la spec.** §1 périmètre → tâches 1 à 10 ; §1.1 non-atteinte à la réplication →
tâches 4 et 11 ; §1.2 le boss dans la horde → tâche 3 ; §2 les paliers → tâche 2 ; §3 la formule →
tâches 1 et 3 ; §4 le boss → tâches 3 à 5 ; §5 l'or → tâche 6 ; §6 le vote → tâches 7 à 10 ; §7 la
porte → tâche 3 ; §8 vérification → tâches 11 et 12.

**Les deux endroits où ce plan a le plus de chances de se tromper**, nommés plutôt que cachés :

1. **La tâche 2 étape 4 laisse une question ouverte à l'exécution** — comment le palier voyage-t-il
   jusqu'au client pour que les PV de départ se dérivent identiquement ? Trois issues plausibles :
   l'ordre de vague gagne un champ, le palier se dérive du `waveId`, ou les PV voyagent déjà résolus.
   **Si l'implémenteur trouve une quatrième voie, qu'il la signale au lieu de choisir en silence.**
2. **`BOSS_HP_BASE` n'a pas de valeur de départ défendable** avant la mesure de la tâche 3. Le plan
   l'assume et engage ses issues d'avance, mais c'est le seul chiffre de ce document qui soit un
   trou.

**Cohérence des types.** `waveCountScale`/`hpScale`/`palierGold` prennent toutes `k` (le palier,
`0` pour le premier) et rendent un facteur ou un montant — jamais un palier. Le boss est un
**archétype**, pas un type d'entité : `Horde` ne gagne aucun tableau, et la liste des quatorze
tableaux à tenir à jour dans `#removeAt` / `spawn` / `saveState` / `restoreState` **ne bouge pas**.
