# Étape 5a — les éléments : plan d'implémentation

> **Pour un agent exécutant :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour
> exécuter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** la piétaille gagne des points de vie, deux éléments marquent les ennemis et le sol, leur
rencontre déclenche une réaction, et une réaction entre deux joueurs charge la barre de Synergie.

**Architecture :** l'état élémentaire ne coûte **rien par entité sur le fil**. Les PV vivent côté
serveur seul — `DEATHS` suffit depuis l'étape 3. Les zones au sol sont annoncées à la création et
leur mort est **dérivée** des deux côtés, comme les orbes. Seules les réactions sont annoncées.

**Pile :** TypeScript strict, workspaces npm, Vitest, PixiJS v8, Biome.

**Spec :** [`../specs/2026-08-27-etape-5a-elements.md`](../specs/2026-08-27-etape-5a-elements.md)

---

## Contraintes globales

Chaque tâche les respecte, sans les répéter.

- **Porte de commit** : `npm run lint`, `npm run typecheck`, `npx vitest run --root back`,
  `npx vitest run --root front`, `npm run build --workspace front` — tous verts **avant** de
  commiter, et on lit le **verdict**, jamais la fin de la sortie. Deux commits sont déjà partis
  avec le lint rouge dans ce dépôt pour cette raison exacte.
- **Mutation testing** : appliquer la mutation sur le disque, relancer, vérifier qu'elle rougit,
  restaurer. **Dix-sept assertions de ce dépôt ne gardaient rien.** Le motif ne varie jamais : le
  test met en scène la bonne intention et rate la ligne qu'il nomme.
- **Quand une mutation survit, chercher d'abord si une AUTRE garde la masque**, avant d'écrire un
  test. Six occurrences à l'étape 4, dont trois soldées par une **suppression de code**.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : l'auteur joue sur les ports 5173 et 3100.
- Aucun asset au dépôt — licence Tiny Swords, dépôt public.
- Commits : sujet en minuscules, en français, type parmi `build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test`.
  Utiliser `git commit -F -` avec un heredoc *quoté* : les backticks dans un `-m` entre guillemets
  doubles sont interprétés par le shell.
- `shared/` interdit `Math.random` et `Date.now` : tout ce qui y vit tourne des deux côtés du fil.

---

## Cohérence des constantes

> À l'étape 3, ce tableau a évité plusieurs défauts et en a causé un : une constante y était donnée
> comme « sans effet sur le déterminisme » — vrai pour le déterminisme, faux pour le **coût**, dont
> c'était le principal levier. **Le tableau ne protège que si les contraintes qu'on y écrit sont les
> bonnes.**

| Constante | Valeur de départ | Contrainte |
| --- | --- | --- |
| `Archetype.hp` (légère) | **5** | = `damage` de la dague : la piétaille meurt en un coup, **le rythme de l'étape 3 est préservé à l'identique** |
| `Archetype.hp` (lourde) | **20** | quatre coups de dague — assez pour porter une marque et réagir |
| `MARK_DURATION_TICKS` | **60** (2 s) | ⚠️ **à régler à l'œil, tâche 11.** Trop court, rien ne réagit ; trop long, tout réagit tout le temps |
| `ZONE_LIFETIME_TICKS` | **90** (3 s) | dérivée des deux côtés depuis `bornTick`, **jamais annoncée** — même modèle que `ORB_LIFETIME_TICKS` |
| `ZONE_RADIUS` | **70** | > `SEPARATION_RADIUS` (28), sinon une zone ne couvre jamais deux ennemis. ⚠️ Sert **aussi** de rayon de fusion : c'est donc lui qui décide du *nombre* de zones, pas seulement de leur coût unitaire |
| `ZONE_CAPACITY` | **128** | plafond dur, avec compteur de troncature — second rideau derrière la règle de fusion |
| `REACTION_RADIUS` | **90** | = `ORB_PICKUP_RADIUS`, pour que le flash couvre visiblement ce qu'il tue |
| `REACTION_DAMAGE` | **25** | > `HEAVY_HP` (20) : un choc vide son rayon. **Raisonné, pas joué** — réglage de la tâche 11 |
| `SYNERGY_MAX` | **20** | tient sur le `u16` déjà prévu dans le snapshot |

> ⚠️ **`ZONE_RADIUS` n'est pas un réglage de sensation.** Le recouvrement de zones est en
> O(zones²) et le marquage en O(zones × entités) : c'est **le** levier de coût de cette étape,
> exactement comme `SEPARATION_STRENGTH` l'était à l'étape 3 sans que le tableau le dise.
>
> ⚠️ **Et ce n'est pas le seul, contrairement à ce que la première version de ce tableau disait.**
> La **cadence des armes élémentaires** en est un au moins aussi gros — trouvé à la tâche 2, mesuré :
> avec « un projectile = une zone », les armes retenues portent 90 zones à quatre joueurs, **209 à
> quatre exemplaires et 368 à huit**, l'empilement de l'étape 4 faisant le reste. Le lance-flammes
> seul en porterait 216.
>
> **C'est pourquoi la règle de pose fusionne** (§5.1 bis de la spec) : le compte devient fonction de
> la surface couverte, pas de la cadence. Un tableau de contraintes ne protège que si les
> contraintes qu'on y écrit sont les bonnes — et celle-ci manquait.

---

## Structure des fichiers

| Fichier | Responsabilité |
| --- | --- |
| `shared/elements.ts` | **créer** — la table des éléments, l'index **est** l'identifiant |
| `shared/archetypes.ts` | + `hp` |
| `shared/weapons.ts` | + `element` |
| `shared/horde.ts` | + `hp`, `mark`, `markBy`, `markUntil` — quatre tableaux par entité, plus `applyMark` / `markAt` |
| `shared/zones.ts` | **créer** — `ZoneField`, calqué sur `OrbField` |
| `shared/protocol.ts` | + `ZONE`, `REACTION` ; la Synergie dans le `SNAPSHOT` |
| `back/src/combat.ts` | les dégâts soustraient ; le marquage ; les réactions |
| `back/src/room.ts` | intègre zones, marques, réactions et Synergie au tick |
| `front/src/net/client.ts` | reçoit `ZONE` et `REACTION`, dérive l'expiration |
| `front/src/render/` | quad teinté, teinte de sprite, flash de réaction, jauge de Synergie |

---

## Tâche 1 : les PV de la piétaille — **la porte**

**Fichiers :** modifier `shared/archetypes.ts`, `shared/horde.ts`, `back/src/combat.ts`, leurs tests

**Interfaces :**
- Produit : `Archetype.hp: number` ; `Horde.hp: Float32Array` ; `resolveProjectileDamage` soustrait au lieu de tuer.

- [ ] **Étape 1 : `Archetype` gagne `hp`.** Les vingt archétypes existants prennent **5** ;
  **quatre d'entre eux passent à 20** et deviennent la piétaille lourde. Le choix des quatre est
  libre — ce sont des sprites, pas des rôles, aujourd'hui.

- [ ] **Étape 2 : `Horde` gagne `hp`.**

  ⚠️ **Le piège connu de ce dépôt.** `Horde.#removeAt` recopie **dix** tableaux du dernier créneau
  vers celui qu'on libère. Un tableau oublié laisse l'entité déplacée avec les PV de celle qui vient
  de mourir. À l'étape 3, le test « emmène toutes les propriétés » vérifiait **2 tableaux sur 7** et
  n'a rien attrapé.

  Le test à écrire vérifie **tous** les tableaux, en les énumérant depuis une liste unique :

  ```ts
  const CHAMPS = ['x', 'y', 'vx', 'vy', 'archetype', 'waveId', 'indexInWave',
                  'animPhase', 'targetField', 'stopped', 'hp'] as const;
  // et une assertion que CHAMPS couvre bien tout ce que #removeAt recopie :
  // compter les lignes de #removeAt est fragile ; comparer a la liste des
  // proprietes tableau de l'instance ne l'est pas.
  ```

- [ ] **Étape 3 : `spawn` remplit `hp` depuis l'archétype.** Les deux côtés dérivent la même valeur
  de départ — l'archétype voyage déjà dans l'ordre de vague de 19 octets.

- [ ] **Étape 4 : `resolveProjectileDamage` soustrait.**

  ```ts
  projectiles.collide(horde, (entityId, damage) => {
    const slot = horde.slotOf(entityId);
    if (slot < 0) return;
    const reste = (horde.hp[slot] ?? 0) - damage;
    horde.hp[slot] = reste;
    if (reste <= 0) deadIds.add(entityId);
  });
  ```

  ⚠️ **Le `Set` de déduplication reste indispensable**, et pour une raison qui change : il ne
  protège plus contre « deux projectiles tuent le même ennemi au même tick » mais contre « le même
  identifiant listé deux fois dans `horde.kill` », que `kill` ne fait que tolérer défensivement.

- [ ] **Étape 5 : le test qui compte.** Un ennemi à 20 PV touché par la dague (5 dégâts) **survit à
  trois impacts et meurt au quatrième**. Vérifier par mutation qu'un `<=` changé en `<` se voit.

- [ ] **Étape 6 : les deux passifs de dégâts se réveillent.** « Puissance » et « acier » ne
  modulaient aucune issue à l'étape 4. C'est la dette de l'étape 4 qui se solde ici.

  ⚠️ **Correction — une première version de ce plan écrivait « deux cartes de puissance font mourir
  un ennemi lourd en moins d'impacts ». C'est arithmétiquement FAUX**, et c'est le motif R9 de
  l'étape 4 : le bonus est une fraction, le nombre d'impacts est un entier, et l'arrondi avale les
  premières cartes.

  | Cartes de « puissance » | Dégâts | Impacts pour 20 PV |
  | --- | --- | --- |
  | 0 | 5,00 | 4 |
  | 1 | 5,50 | 4 |
  | 2 | 6,00 | **4** |
  | 3 | 6,50 | 4 |
  | **4** | 7,00 | **3** |

  **Il en faut quatre.** Le test doit le dire, et vérifier le palier là où il est — un test écrit
  sur « deux » aurait échoué et fait croire à un défaut de câblage.

- [ ] **Étape 7 : la porte.** Mesurer le **rythme de mise à mort** à quatre joueurs, avec la
  proportion de lourds visée.

  ⚠️ **Correction — `sim.bench.ts` ne peut PAS le mesurer.** Il a sa propre classe `Horde` locale et
  ne fait qu'avancer des positions : aucun combat, aucune mort. Une première version de ce plan
  demandait de le rejouer, ce qui est inexécutable. Un banc dédié (`kills.bench.ts`) est le bon
  outil — **exactement le constat de la tâche 12 de l'étape 4**, où aucun des trois bancs ne
  mesurait ce que la tâche demandait.

  **Le réglage se juge en jeu — décision de l'auteur, prise après la tâche 1** :

  > *« Pas besoin de mesurer le rythme de mise à mort, je testerai et ferai des retours. »*

  Le banc `kills.bench.ts` reste disponible (`npm run bench:kills -w back`) mais **quitte la chaîne
  `npm run bench` et cesse d'être une porte.** Les trois issues qui étaient engagées d'avance ne
  s'appliquent plus : c'est l'œil qui tranche.

- [ ] **Étape 7 bis : moins d'ennemis au début — décision de l'auteur, prise d'avance.**

  > *« On fera moins d'ennemi au début, le temps d'obtenir des armes. »*

  L'issue 3 est donc **pré-autorisée** : `waveCountBounds` s'ouvre sans avoir à remonter la
  question. Les valeurs actuelles de `back/src/wave-director.ts` :

  | Constante | Actuelle |
  | --- | --- |
  | `WAVE1_MIN_COUNT` | 16 |
  | `WAVE1_MAX_COUNT` | 28 |
  | `RAMP_WAVES` | 20 |
  | `STEADY_MIN_COUNT` | 120 |
  | `STEADY_MAX_COUNT` | 320 |

  **Ce qu'il faut faire baisser, c'est le DÉBUT, pas le régime établi.** Le raisonnement de
  l'auteur est le temps d'obtenir des armes : la première arme arrive au premier draft, donc au
  premier niveau, donc après ~10 orbes en solo. La première vague tombe au tick 180 (6 s).

  Deux leviers, et ils ne font pas la même chose :
  - **baisser `WAVE1_*`** rend les premières vagues plus petites — c'est ce que l'auteur demande ;
  - **augmenter `RAMP_WAVES`** étale la montée sur plus de vagues, donc laisse plus de temps avant
    le régime établi.

  **Les deux, et le dire dans le commit avec les chiffres retenus.** Ne pas toucher à
  `STEADY_*` : le régime établi est ce que les bancs mesurent, et le §4.1 de l'orientation y tient.

  ⚠️ **Vérifier que le niveau 2 reste atteignable.** Le test « le niveau 2 est atteignable » de
  l'étape 3 existe ; moins d'ennemis, c'est moins d'orbes, et le seuil ne bouge pas. Un début trop
  maigre repousserait la première arme au lieu de l'avancer — l'inverse exact de l'intention.

- [ ] **Étape 8 : commit** — `feat(shared): la pietaille gagne une reserve de points de vie`

---

## Tâche 2 : le catalogue des éléments

**Fichiers :** créer `shared/elements.ts`, `shared/elements.test.ts` ; modifier `shared/weapons.ts`

**Interfaces :**
- Produit : `ELEMENT = { NEUTRE: 0, BRAISE: 1, GIVRE: 2 }` ; `Weapon.element: number`.

- [ ] **Étape 1 : la table.** Même motif que `passives.ts` et `weapons.ts` — l'index **est**
  l'identifiant, rien à synchroniser entre serveur et clients.

  ```ts
  export interface Element {
    id: number;
    name: string;
    /** Teinte du sprite et du quad, en 0xRRGGBB. */
    tint: number;
    /** Degats par tick tant que la marque tient. 0 : aucun. */
    burnPerTick: number;
    /** Facteur de vitesse applique a l'ennemi marque. 1 : aucun. */
    slowFactor: number;
  }
  ```

  Braise : `burnPerTick > 0`, `slowFactor = 1`. Givre : `burnPerTick = 0`, `slowFactor < 1`.
  `NEUTRE` occupe l'index 0 et n'a aucun effet — **un élément neutre n'est pas un cas particulier,
  c'est une entrée de la table**, comme `BASE_WEAPON_ID` l'est pour les armes.

- [ ] **Étape 2 : `Weapon` gagne `element`, à `NEUTRE` par défaut.** Deux armes passent en Braise,
  deux en Givre. **L'arme de base reste neutre** — le §6.3 en fait *« un socle pour les joueurs qui
  ne veulent pas jouer le système »*.

- [ ] **Étape 3 : le test qui n'est pas creux.** Vérifier que **chaque élément du catalogue a au
  moins une arme**, et qu'aucune arme ne référence un élément inexistant. Une référence morte ne se
  verrait qu'au premier tir de cette arme, plusieurs tâches plus tard.

- [ ] **Étape 4 : commit** — `feat(shared): le catalogue des elements`

---

## Tâche 3 : la marque élémentaire sur un ennemi

**Fichiers :** modifier `shared/horde.ts`, `shared/constants.ts`, leurs tests

**Interfaces :**
- Produit : `Horde.mark`, `Horde.markBy`, `Horde.markUntil` (`Uint8Array`, `Uint8Array`,
  `Float64Array`) ; `MARK_DURATION_TICKS`.

- [ ] **Étape 1 : trois tableaux, et le même piège — mais à QUATRE endroits, pas trois.**

  Le plan ne citait que `#removeAt`, `saveState` et `restoreState`. **Il oubliait `spawn`, qui est
  le plus dangereux des quatre** : un créneau libéré garde le contenu du mort, donc sans remise à
  zéro un monstre neuf naît **marqué Braise par un joueur qu'il n'a jamais croisé** — capable de
  déclencher une réaction *et une charge de Synergie* au premier projectile Givre. Trouvé à
  l'exécution.

  | Site | Ce qu'il faut y faire |
  | --- | --- |
  | `#removeAt` | recopier les trois tableaux du dernier créneau |
  | `saveState` / `restoreState` | les porter pour le rejeu |
  | **`spawn`** | **les remettre à zéro** — le créneau est peut-être recyclé |

  ⚠️ **Et il y a trois listes de tableaux à tenir à jour, pas une.** Outre la liste unique de la
  tâche 1 : `HordeHistoryLike` dans `horde.test.ts` recopiait la forme de `HordeState` à la main
  (fermée par un `import type`), et le test d'aller-retour de `horde-history.test.ts` énumérait sans
  garde de couverture (fermée par la même assertion). **Une liste recopiée sans garde vieillit en
  silence** — c'est le motif de la constante recopiée, appliqué aux formes.

- [ ] **Étape 2 : `applyMark(slot, element, playerId, tick)`.** Écrit les trois tableaux et pose
  `markUntil = tick + MARK_DURATION_TICKS`.

  ⚠️ **Correction — une première version de ce plan appelait cette méthode `mark`**, tout en
  demandant un **tableau** `Horde.mark`. Les deux ne peuvent pas coexister sur la même classe. Les
  noms de tableaux gagnent : c'est la convention de toute la classe, et c'est eux que la liste
  unique du test énumère.

  ⚠️ **`markBy` est ce qui rend la Synergie possible** (§7 de la spec). Sans lui, on ne peut pas
  distinguer une réaction entre deux joueurs d'une réaction en solo, et le §6.5 de l'orientation
  — *« le cœur du projet »* — n'a plus de données.

- [ ] **Étape 3 : la marque expire, et l'expiration est DÉRIVÉE.** `markUntil` se compare au tick
  courant ; rien n'est annoncé. Même modèle que `ORB_LIFETIME_TICKS`.

- [ ] **Étape 4 : le test.** Une marque posée au tick T vaut encore au tick
  `T + MARK_DURATION_TICKS - 1` et plus au tick `T + MARK_DURATION_TICKS`.

  ⚠️ **Tester les DEUX bornes.** Un test qui ne vérifie que « ça expire un jour » passe avec
  n'importe quelle durée.

- [ ] **Étape 5 : commit** — `feat(shared): la marque elementaire et son expiration derivee`

---

## Tâche 4 : les zones au sol

**Fichiers :** créer `shared/zones.ts`, `shared/zones.test.ts` ; modifier `shared/constants.ts`

**Interfaces :**
- Produit : `ZoneField` — `spawn(element, x, y, playerId, tick)`, `expire(tick)`, `overlaps(a, b)`,
  `count`, `truncatedZones`, tableaux publics `element`, `x`, `y`, `by`, `bornTick`.

⚠️ **Contrat d'ordre :** `spawn` suppose que l'appelant a appelé `expire(tick)` **d'abord**, une
fois par tick — même contrat que `OrbField.resolvePickups`, qui expire avant de résoudre. Sans ça,
une zone périmée mais pas encore retirée serait *rafraîchie* au lieu d'être remplacée. **C'est à la
tâche qui intègre `ZoneField` dans `Room.step` de le respecter**, pas à `spawn` de s'en défendre —
une garde défensive ici serait le motif « deux gardes qui se couvrent », et la seconde ne serait
testable qu'en mettant en scène un appelant fautif.

- [ ] **Étape 1 : calquer `OrbField`.** `back/src/combat.ts` en contient déjà un exemplaire complet
  et éprouvé : capacité fixe, tableaux typés, **retrait par indice décroissant**, expiration dérivée
  du `bornTick`. Le lire avant d'écrire, et suivre sa forme.

  ⚠️ Il vit dans `shared/` et pas dans `back/` : **le client dessine les zones et doit dériver leur
  mort exactement comme le serveur.** Une expiration calculée différemment des deux côtés ferait
  disparaître un quad plus tôt chez l'un — visible, et le début d'une divergence.

- [ ] **Étape 1 bis : la règle de pose, bornée par construction.** `spawn` **ne crée pas** de zone
  si une zone du même élément recouvre déjà le point : elle rafraîchit son `bornTick`. Le compte
  devient fonction de la surface, pas de la cadence — voir §5.1 bis de la spec, et les chiffres qui
  l'imposent.

  Et un plafond dur `ZONE_CAPACITY` avec un compteur de troncature, comme `PROJECTILE_CAPACITY` et
  `truncatedProjectiles` à l'étape 4. **Une zone qui ne se pose pas est un effet payé qui ne se voit
  pas : ça ne doit jamais disparaître sans trace.**

  Le test qui compte : **mille poses au même endroit ne font qu'une zone**, et mille poses étalées
  en font plusieurs. Sans les deux moitiés, une fusion qui avale tout passerait.

- [ ] **Étape 2 : `overlaps(a, b)`.** Deux zones se recouvrent si la distance de leurs centres est
  inférieure à la somme des rayons. **Comparer les carrés**, jamais `Math.hypot` : c'est la
  convention de tout le dépôt (`resolvePickups`, `resolveContact`, `collide`).

- [ ] **Étape 3 : le test qui ne triche pas.** Deux zones **exactement tangentes** ne se recouvrent
  pas ; deux zones à un pixel de moins se recouvrent. Le cas limite est le seul qui distingue un
  `<` d'un `<=`.

- [ ] **Étape 4 : commit** — `feat(shared): les zones au sol, expiration derivee`

---

## Tâche 5 : le protocole

**Fichiers :** modifier `shared/protocol.ts`, `shared/protocol.test.ts`

**Interfaces :**
- Produit : `MSG.ZONE`, `MSG.REACTION` ; `encodeZone`, `encodeReaction` ; la Synergie dans le snapshot.

- [ ] **Étape 1 : `ZONE`.** `type u8 · element u8 · x i16 · y i16 · bornTick u32 · by u8` = **11
  octets**. Un message par zone, à la création.

  ⚠️ **Onze, pas douze.** Une première version de ce plan écrivait 12 : la spec disait « ~12 »,
  un ordre de grandeur, et je l'ai durci en chiffre exact **sans recompter**. La liste de champs
  fait foi. L'octet manquant était le `rayon` que la table du §8 de la spec listait encore, et qui
  n'a pas à voyager — voir §5.3.

  ⚠️ **La mort d'une zone n'est JAMAIS annoncée** : elle se dérive du `bornTick`. Un message de
  disparition doublerait le trafic pour une information que les deux côtés calculent déjà.

- [ ] **Étape 2 : `REACTION`.** `type u8 · pair u8 · x i16 · y i16 · tick u32 · synergie u8` = **11
  octets**. Le couple tient sur un octet, **un quartet par élément, canonicalisé** : le §6.2 est
  symétrique, donc Braise+Givre et Givre+Braise doivent porter le même octet, sinon deux clients
  dessinent deux flashs différents pour un événement identique. `synergie` vaut 1 quand deux joueurs différents sont à l'origine, 0 sinon.

  ⚠️ **La charge voyage DANS `REACTION`**, pas dans un message à part : les deux arrivent toujours
  ensemble et un second message ne porterait rien de plus.

- [ ] **Étape 3 : la Synergie dans le `SNAPSHOT`.** Un `u16` d'équipe, à côté de l'expérience.
  `SNAPSHOT_HEADER_BYTES` passe de 8 à 10.

  ⚠️ **Un seul nombre pour l'équipe, jamais un par joueur.** L'étape 3 a fait l'erreur inverse avec
  l'expérience — deux sources de vérité pour un seul nombre — et l'implémenteur l'avait signalée.

- [ ] **Étape 4 : les tests d'aller-retour**, avec une **assertion de taille en chiffre nu**
  (`expect(SNAPSHOT_HEADER_BYTES).toBe(10)`) : c'est ce qui attrape un décalage d'octet, pas une
  comparaison à la constante elle-même.

  ⚠️ Le test de troncature doit utiliser `toThrow(/tronque/)` et **jamais** `toThrow()` nu : un
  `RangeError` de `DataView` le ferait passer même sans le contrôle de longueur. Défaut réel de
  l'étape 4.

- [ ] **Étape 5 : commit** — `feat(shared): les messages ZONE et REACTION`

---

## Tâche 6 : marquer, brûler, ralentir

**Fichiers :** modifier `back/src/combat.ts`, `back/src/room.ts`, leurs tests

- [ ] **Étape 1 : un projectile élémentaire marque ce qu'il touche.** Dans `resolveProjectileDamage`, après
  la soustraction : si l'arme porte un élément et que l'ennemi survit, poser la marque.

  ⚠️ **Un ennemi qui meurt du même impact n'est pas marqué** — la marque serait posée sur un
  créneau que `kill` va compacter, donc sur une **autre** entité. C'est la classe de défaut la plus
  coûteuse de ce dépôt.

- [ ] **Étape 2 : un ennemi dans une zone est marqué**, et la marque se rafraîchit tant qu'il y
  reste. O(zones × entités) : c'est le coût que la tâche 10 doit mesurer.

- [ ] **Étape 3 : la Braise brûle, le Givre ralentit.** Les dégâts sur la durée s'appliquent au
  tick ; le ralentissement multiplie la vitesse dans `Horde.step`.

  ⚠️ **Le ralentissement est le premier effet qui touche le DÉPLACEMENT**, donc le contrat de
  réplication à 0,000 px. **Tranché : l'effet porte sur la ZONE, pas sur la marque.**

  | | Ce que le client sait | Verdict |
  | --- | --- | --- |
  | Effet de **marque** | rien — la marque ne voyage pas | il ne peut pas dériver le ralentissement |
  | Effet de **zone** | tout — les zones sont annoncées, leur mort dérivée | il dérive exactement le même |

  Les deux côtés connaissent les zones et les positions ; les positions sont **bit-identiques**
  (c'est ce que « 0,000 px » veut dire), donc le prédicat `dx² + dy² < r²` rend le **même booléen**
  des deux côtés. Zéro octet de plus, zéro divergence.

  ⚠️ **Et l'effet est DATÉ PAR TICK, pas appliqué à la réception.** C'est la leçon du gel de niveau
  de l'étape 3 : le serveur ralentit depuis `bornTick`, le client reçoit `ZONE` quelques ticks plus
  tard. S'il applique le ralentissement à la réception, il diverge de la latence exacte.

  Le client doit donc traiter `ZONE` comme il traite déjà `DEATHS` : **revenir au `bornTick` et
  rejouer**, via `HordeHistory`. La machinerie existe.

  **Et elle a la même limite, déjà mesurée** : l'anneau fait `ROLLBACK_DEPTH_TICKS = 8` ticks. Une
  `ZONE` qui arrive plus tard tombe hors de l'anneau. L'étape 3 a mesuré ce cas pour les morts —
  **93,007 px de dérive** quand on applique au présent en le signalant — et c'est le comportement à
  reprendre : appliquer au présent, compter l'événement, ne pas prétendre que c'est exact.

  **Un troisième chemin est possible et je ne l'ai pas retenu** : ne pas ralentir du tout et faire
  du Givre un pur marqueur pour la réaction. Ce serait plus sûr et plus pauvre — le §6.3 de
  l'orientation lui donne « ralentit » comme effet seul, et un élément dont l'effet seul est nul ne
  se sent pas. **Si la dérive mesurée à l'étape 4 ci-dessous est mauvaise, c'est ce chemin-là qu'il
  faut prendre**, et le dire, plutôt que de bricoler.

- [ ] **Étape 4 : les tests**, dont un qui **mesure la dérive** entre serveur et client avec du
  Givre en jeu. Le scénario de `shared/horde.replication.test.ts` est le modèle.

- [ ] **Étape 5 : commit** — `feat(back): marquer, bruler, ralentir`

---

## Tâche 7 : la réaction

**Fichiers :** modifier `back/src/combat.ts`, `back/src/room.ts`, leurs tests

- [ ] **Étape 1 : les quatre déclencheurs** du §6.2 de la spec, et **eux seuls** :
  ennemi marqué + projectile d'un autre élément ; ennemi marqué + entrée dans une zone d'un autre
  élément ; deux zones d'éléments différents qui se recouvrent (**une seule fois, à la création de
  la seconde**) ; et surtout **pas** le même élément, qui rafraîchit la marque.

- [ ] **Étape 2 : la borne d'une réaction par ennemi et par tick.**

  ⚠️ **Ne mets pas en scène « vingt ennemis, une zone » : ça ne prouve rien.** Vingt est aussi le
  compte avec la borne, puisqu'elle est *par ennemi*. Le décor qui distingue les deux cas est
  **plusieurs zones d'éléments alternés au même tick** — 40 réactions sans borne, 20 avec.

- [ ] **Étape 3 : la réaction tue par `REACTION_RADIUS`**, et les morts passent par le `DEATHS`
  existant — **aucun chemin de mort parallèle**. Le rejeu de l'étape 3 en dépend.

- [ ] **Étape 4 : le test de non-régression le plus important.** Rejouer
  `shared/horde.replication.test.ts` : **les trois chiffres doivent rester à 0,000 px** avec des
  réactions en jeu. C'est le §2 de la spec.

- [ ] **Étape 5 : commit** — `feat(back): le choc thermique`

---

## Tâche 8 : le compteur de Synergie

**Fichiers :** modifier `back/src/room.ts`, `back/src/room.test.ts`, `back/src/combat.ts`
(un commentaire qui promet `synergyCharge: false`), **`back/src/server.test.ts`** — une assertion y
devient fausse, et un implémenteur qui s'en tiendrait à la liste casserait la suite

- [ ] **Étape 1 : la règle, en une ligne.** À la réaction, comparer `markBy` et le joueur qui
  déclenche : **différents → une charge**. Même joueur → la réaction a lieu, elle ne rapporte rien.

- [ ] **Étape 2 : le test qui porte le livrable du §13.**

  ```
  joueur 1 marque Braise, joueur 2 applique Givre  -> la barre monte
  joueur 1 marque Braise, joueur 1 applique Givre  -> la barre ne bouge PAS
  ```

  ⚠️ **Les deux moitiés, toujours.** Un test qui ne vérifie que la première passe avec un compteur
  qui monte à chaque réaction — et c'est exactement le défaut que la spec d'orientation appelle
  « le cœur du projet ».

- [ ] **Étape 3 : la barre plafonne à `SYNERGY_MAX` et n'est jamais dépensée** à cette étape
  (l'ultime est hors périmètre). Le test le dit explicitement, pour qu'on ne prenne pas le plafond
  pour un oubli.

  ⚠️ **Le décor doit produire STRICTEMENT PLUS de charges que le plafond**, sinon « un plafond jamais
  atteint » se lit comme « un plafond respecté ». Même famille que R24.

  ⚠️ **Et le bit `synergyCharge` reste à 1 quand la barre est pleine** : il porte la comparaison, pas
  l'état de la jauge. Un bit asservi à la jauge obligerait le client à connaître le plafond pour
  interpréter le message.

- [ ] **Étape 4 : commit** — `feat(back): le compteur de Synergie`

---

## Tâche 9 : le client reçoit et dessine

**Fichiers :** modifier `front/src/net/client.ts`, `front/src/render/`, leurs tests

- [ ] **Étape 1 : recevoir `ZONE` et `REACTION`**, et **dériver l'expiration des zones** avec la
  même constante que le serveur. Aucun message de disparition à attendre.

- [ ] **Étape 2 : la teinte de sprite est COSMÉTIQUE et approximée.** Le client marque ce que ses
  propres projectiles touchent, et ce qui est dans une zone. **Il peut se tromper, et ça ne coûte
  rien** — la réaction, elle, vient du serveur. Le dire dans le code, sinon quelqu'un « corrigera »
  cette approximation un jour en la rendant autoritaire.

- [ ] **Étape 3 : le rendu**, selon la hiérarchie du §6.6 :
  quad teinté additif pour la zone · teinte de sprite pour l'ennemi marqué (**gratuite** dans le
  batch Pixi) · flash court et large pour la réaction · jauge de Synergie dans le HUD.

  ⚠️ **L'état persistant est discret, la réaction est spectaculaire.** Si les ennemis marqués
  brillent en permanence, plus rien ne se lit et le budget de particules part en bruit de fond.

- [ ] **Étape 4 : le rendu se teste sous jsdom** là où il est observable, et l'expiration des zones
  se teste tout court. `front/src/ui/draft.test.ts` est le modèle.

- [ ] **Étape 5 : commit** — `feat(front): les zones, les teintes et le flash de reaction`

---

## Tâche 9 bis : rendre `main.ts` testable — **la dette qui mord pour la troisième fois**

**Fichiers :** modifier `front/src/main.ts`, créer `front/src/main.test.ts`

**Ce n'est pas au plan d'origine.** Elle y entre parce que le défaut a maintenant trois occurrences
et que chacune a été découverte *après coup* :

| Étape | Ce qui n'était gardé par rien | Découvert |
| --- | --- | --- |
| 3 | le gel de niveau côté client — le paramètre existait, le câblage non | par mutation, 76 tests verts |
| 4 | `draftScreen.update()` dans la boucle de rendu | par le sous-agent, 117 tests verts |
| 5a | `drawZones`, `drawReactionFlashes`, `paintSynergy` | par le sous-agent, **170 tests verts** |

**La cause est unique et structurelle** : `main.ts` fait ses recherches DOM et son `await
stage.init()` **au niveau module**, donc l'importer dans un test exécute tout le démarrage. Aucun
test ne peut donc atteindre `renderFrame`, et **sept mutations survivent** rien qu'à la tâche 9.

- [ ] **Étape 1 : séparer le câblage du démarrage.** Extraire de `main.ts` une fonction pure —
  `composeFrame(state, cibles)` ou équivalent — qui **décide ce qui est dessiné**, sans rien
  instancier. `main.ts` garde le démarrage et l'appelle.

  ⚠️ **Ne déplace pas le problème.** Le critère est vérifiable : une mutation qui retire un appel de
  dessin doit rougir. Si elle survit encore, l'extraction n'a rien extrait.

- [ ] **Étape 2 : le test.** Un double de `Stage` qui enregistre ce qu'on lui demande de dessiner, et
  une assertion que **chaque calque reçoit son appel** — zones, horde, projectiles, flashs, joueurs,
  orbes, HUD.

- [ ] **Étape 3 : la mutation qui juge.** Retirer chacun des appels, un par un, et vérifier que
  chacun rougit. **C'est la seule mesure qui compte** — les sept survivantes de la tâche 9 doivent
  toutes mourir.

- [ ] **Étape 4 : commit** — `refactor(front): rendre la boucle de rendu testable`

---

## Tâche 10 : quatre clients, en headless — **le livrable du §13**

**Fichiers :** étendre `back/src/draft.integration.test.ts` ou en créer un voisin

- [ ] **Étape 1 : quatre clients réels, sur des sockets réelles.** Le harnais existe déjà
  (`app.decorate('rooms', registry)`, `buildServer({ roomSeed })`) — le réutiliser, ne pas le
  réinventer. Poser les monstres soi-même : le générateur de vagues est lent **et flaky**.

- [ ] **Étape 2 : ce que le test doit assener**, et pas seulement « ça n'a pas planté » :
  - une réaction **a eu lieu** — sinon le test ne prouve rien, et c'est le défaut le plus probable ;
  - une réaction **entre deux joueurs charge** la barre ;
  - la **même réaction en solo ne charge rien** ;
  - **deux zones qui se recouvrent réagissent** ;
  - les **trois chiffres de réplication restent à 0,000 px**.

- [ ] **Étape 3 : mesurer le coût.** Étendre `back/bench/slots.bench.ts` ou en écrire un voisin :
  pas p95 avec 30 zones vivantes à 1 500 et 4 000 entités. **`ZONE_RADIUS` est le levier**, et le
  tableau des constantes le dit.

- [ ] **Étape 3 bis : borner le trafic des rafraîchissements — trouvé à la tâche 6.**

  La fusion fait repartir le `bornTick` d'une zone existante. **Ce rafraîchissement doit être
  annoncé**, sinon la zone du client meurt avant celle du serveur. Conséquence non vue à
  l'écriture : **le trafic `ZONE` suit alors la cadence des armes, pas le nombre de zones vivantes**
  — exactement le couplage que le §5.1 bis avait supprimé pour le *compte*. Mesuré à la tâche 6 :
  9 annonces pour 3 zones vivantes sur ~30 ticks.

  ⚠️ **Les chiffres d'une première version de ce plan étaient faux dans les deux sens.** Ils
  comptaient par *pose* ; le serveur annonce par *zone*. La borne réelle est « nombre de zones ×
  fréquence de tick », mesurée :

  | Zones vivantes, arrosées à chaque tick | Sans la parade | Avec |
  | --- | --- | --- |
  | 15 | 4,83 ko/s | **0,10** |
  | 30 | **9,67 ko/s** | **0,19** |
  | 60 | 19,34 ko/s | **0,39** |

  Contre **1,22 ko/s** de trafic total à l'étape 4. Dans un salon réaliste le trafic n'était que de
  0,13 ko/s — **mais c'est la borne qui compte**, et elle valait deux fois et demie l'estimation.

  **La parade : l'annonce EST la vérité.** Le `bornTick` qui fait foi est celui de la dernière
  annonce, et une zone n'est ré-annoncée qu'au plus une fois toutes les `ZONE_LIFETIME_TICKS / 2`.
  Entre deux annonces, **le serveur ne prolonge pas non plus** — donc les deux côtés lisent le même
  `bornTick`, sans divergence, et le trafic redevient fonction du **nombre de zones**, que la fusion
  borne déjà par la surface.

  Le test : entretenir une zone en tirant dessus sans relâche pendant plusieurs vies de zone, et
  **compter les annonces**. Elles doivent croître avec le temps, pas avec la cadence.

- [ ] **Étape 4 : commit** — `test(back): une reaction inter-joueurs charge la barre`

---

## Tâches 12 à 14 : ce que la vérification manuelle a trouvé

**Ces trois tâches viennent de l'auteur en train de jouer, comme les quinze de l'étape 3.** Elles
n'étaient dans aucun plan.

> *« Fais des projectiles différents pour chaque arme, en forme, taille, couleur, halo, avec une
> traînée, et fais-les durer plus longtemps ou fade pour les armes courte portée comme le
> lance-flammes. Je ne vois pas la marque sur les ennemis, fais un anneau sous leurs pieds plutôt
> que changer leur couleur. Les ennemis sont trop petits par rapport à la taille des projectiles et
> la hitbox semble plus basse. »*

---

## Tâche 12 : un projectile par arme

**Fichiers :** modifier `shared/weapons.ts`, `front/src/render/projectile-renderer.ts`, leurs tests

Aujourd'hui **toutes les armes tirent le même point lumineux**. Neuf armes, une seule apparence.

- [ ] **Étape 1 : la donnée, pas le code.** `Weapon` gagne un descriptif visuel — forme, diamètre,
  teinte, halo, traînée, atténuation. Même motif que tout le reste de `shared/` : une table, l'index
  est l'identifiant, **ajouter une arme reste du contenu**.

  ⚠️ **La teinte du projectile n'est PAS celle de l'élément.** Une arme neutre doit être
  reconnaissable, et deux armes du même élément doivent se distinguer. L'élément se lit à la zone
  qu'elle laisse et à l'anneau sous l'ennemi (tâche 13) — pas au projectile.

- [ ] **Étape 2 : la traînée.** Un projectile laisse une trace derrière lui. ⚠️ **C'est le poste de
  coût de cette tâche** : `PROJECTILE_CAPACITY` vaut 1024 et une traînée de N segments multiplie les
  quads par N. Mesurer, et borner par construction plutôt que par espoir — le §4.3 de l'orientation
  dit que *« le danger est le VFX, pas les sprites »*.

- [ ] **Étape 3 : la portée se voit.** Le lance-flammes (vie 10 ticks) doit s'éteindre en fondu ;
  l'arc-lourd (40 ticks) doit filer net. **L'atténuation se dérive de `projectileLifeTicks`**, elle
  n'est pas un réglage séparé — sinon les deux dérivent l'un de l'autre.

- [ ] **Étape 4 : commit** — `feat(front): un projectile par arme`

---

## Tâche 13 : la marque devient un anneau au sol

**Fichiers :** modifier `front/src/render/`, `front/src/render/frame.ts`, leurs tests

> *« Je ne vois pas la marque sur les ennemis, fais un anneau sous leurs pieds plutôt que changer
> leur couleur. »*

- [ ] **Étape 1 : remplacer, pas ajouter.** La teinte de sprite disparaît. `markTint` et le
  `color: true` du conteneur de horde partent avec elle — **du code que rien ne lit est du code qui
  ment**.

- [ ] **Étape 2 : l'anneau.** Sous les pieds, teinté par l'élément, sur le calque des zones (le plus
  bas) pour qu'il passe sous les créatures.

  ⚠️ **Écart assumé au §6.6 de l'orientation, et il coûte.** La hiérarchie y donnait la teinte de
  sprite comme **gratuite** (« 0 » dans le batch Pixi) et réservait l'anneau au cas « deux éléments
  avant réaction ». Un anneau par ennemi marqué coûte **un quad par ennemi marqué**. À 1 500
  entités dans une zone, c'est 1 500 quads.

  **Mesurer, et borner** : au minimum le culling hors caméra, comme `selectZones` le fait déjà.

- [ ] **Étape 3 : commit** — `feat(front): la marque elementaire devient un anneau au sol`

---

## Tâche 14 : l'échelle et l'ancre

**Fichiers :** modifier `front/src/render/horde-renderer.ts`, ses tests

> *« Les ennemis sont trop petits par rapport à la taille des projectiles et la hitbox semble plus
> basse. »*

**Mesuré avant d'agir** :

| | |
| --- | --- |
| hitbox | cercle de rayon 32 px, **centré sur la position** |
| sprite | 64 px de haut, **ancré à 0,75** — il s'étend de `y-48` à `y+16` |
| centre visuel du corps | **`y - 16 px`**, soit 25 % du corps au-dessus de la hitbox |
| texture d'impact | 48 px, soit **75 %** du diamètre de la créature, plus au flash |

**« La hitbox semble plus basse » n'est pas une impression : elle l'est de 16 px.**

- [ ] **Étape 1 : l'ancre.** Le corps doit se centrer sur la position, puisque **tout le reste y est
  centré** — contact, ramassage, séparation, tir. C'est l'ancre qui est fausse, pas les rayons.

  ⚠️ **Et l'anneau de la tâche 13 doit être sous les PIEDS**, donc décalé vers le bas du corps, pas
  posé sur la position. Les deux tâches se rencontrent ici.

- [ ] **Étape 2 : le rapport de taille.** Deux leviers, et le plan tranche : **les projectiles
  rétrécissent** (tâche 12 leur donne des tailles propres), et la créature gagne un facteur de corps
  **modeste et documenté**.

  ⚠️ **L'étape 3 a corrigé le défaut INVERSE** — des sprites dessinés à 192 px pour une hitbox de
  64 — et `spriteScale` existe précisément pour lier les deux. **Un facteur de corps rend la hitbox
  menteuse dans l'autre sens** : le garder petit, et l'écrire dans la doc de `spriteScale` au lieu
  de le glisser dans un nombre.

- [ ] **Étape 3 : commit** — `fix(front): centrer le corps sur la hitbox et revoir l'echelle`

---

## Tâche 11 : vérification manuelle et clôture

- [ ] **Jouer une run, au premier plan.** Un onglet en arrière-plan a son `requestAnimationFrame`
  suspendu ; la poignée `window.__tarnok` permet d'avancer les images à la main.

- [ ] **Régler `MARK_DURATION_TICKS` à l'œil.** C'est la question que la spec laisse explicitement
  ouverte, et l'auteur a tranché : **à tester en jeu**. `tsx watch` relance le back tout seul —
  éditer la constante, recharger la page. Partir de 60 (2 s), essayer 30 et 120.

- [ ] **Ce qui relève du jugement**, et que rien n'automatise :
  - une piétaille avec des PV **se sent-elle** encore comme de la chair à canon, ou comme une
    éponge ?
  - la réaction se lit-elle **sans explication** ?
  - la teinte élémentaire se distingue-t-elle à 1 500 entités sur des sprites minuscules — *« le
    problème visuel le plus difficile du projet »* (§6.6) ;
  - la barre de Synergie donne-t-elle envie de se regrouper, ou passe-t-elle inaperçue ?

- [ ] **Rejouer les bancs de la chaîne** (`npm run bench -w back`) — les zones changent le coût du
  tick. **Le rythme de mise à mort n'y est plus** : il se juge en jeu, et `bench:kills` reste à la
  demande pour vérifier qu'un changement ne l'a pas ruiné en silence.

- [ ] Écrire `docs/plans/2026-08-27-etape-5a-resultats.md` et mettre à jour le `README.md`.

- [ ] **Commit** — `docs: resultats de l'etape 5a`

---

## Auto-relecture

**Couverture de la spec.** §1 périmètre → tâches 1 à 9 ; §2 non-atteinte à la réplication →
tâches 6 étape 4, 7 étape 4 et 10 étape 2 ; §3 les PV → tâche 1 ; §4 les éléments → tâches 2 et 3 ;
§5 les zones → tâche 4 ; §6 la réaction → tâche 7 ; §7 la Synergie → tâche 8 ; §8 le protocole →
tâche 5 ; §9 l'encodage visuel → tâche 9 ; §10 vérification → tâches 10 et 11 ; §12 questions
ouvertes → tâche 11.

**Le risque le plus mal couvert par ce plan**, et il est nommé plutôt que caché : **le
ralentissement du Givre touche le déplacement, donc le contrat de réplication.** La tâche 6 étape 3
lui donne deux issues et recommande la seconde (l'effet de zone, que le client dérive), mais c'est
le seul endroit de ce plan où un choix d'architecture reste ouvert à l'exécution. Si l'implémenteur
trouve une troisième voie, **qu'il la signale au lieu de choisir en silence** — onze erreurs du plan
de l'étape 3 ont été rattrapées comme ça.

**Cohérence des types.** `ELEMENT.NEUTRE = 0` est à la fois l'index 0 de la table et la valeur par
défaut de `Weapon.element` : une seule valeur, pas deux conventions. `Horde.mark` vaut `0` pour
« aucune marque » **et** `ELEMENT.NEUTRE` — c'est délibéré, et le dire, parce qu'une sentinelle qui
coïncide avec une valeur réelle est exactement ce que `NO_TOKEN` évite à l'étape 4.
