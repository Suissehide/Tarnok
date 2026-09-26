# Étape 5c — Chaux, Vif-argent, les neuf dernières réactions : plan d'implémentation

> **Pour les exécutants :** chaque tâche est faite par un sous-agent frais, vérifiée par campagne de
> mutations avant commit. Les étapes sont des cases à cocher.

**But :** six éléments, quinze réactions — la fin du §6.3 et du §6.4 — **pour zéro octet de plus sur
le fil**, et le pitch du README enfin vrai.

**Architecture :** tout effet de déplacement vit sur une **zone annoncée**, dont les deux côtés
dérivent le même prédicat à partir de positions bit-identiques. Tout effet de dégât vit **côté serveur
seul**. La liaison du Vif-argent se **dérive** (même zone + proximité) et n'est **pas transitive**. Le
contrat des projectiles reste **découplé** de celui de la horde.

**Spec :** [`../specs/2026-09-26-etape-5c-chaux-vif-argent.md`](../specs/2026-09-26-etape-5c-chaux-vif-argent.md)

## Contraintes globales

- **Aucun message nouveau, aucun champ ajouté.** `ZONE_BYTES = 11`, `REACTION_BYTES = 11`,
  `SNAPSHOT_HEADER_BYTES = 22` ne bougent pas. Le nibble de réaction fait 4 bits : **quinze réactions
  sur seize valeurs, une de reste.**
- **`Horde` ne gagne AUCUN tableau typé.** Les quatorze et leurs quatre sites de synchronisation
  (`#removeAt`, `spawn`, `saveState`, `restoreState`) sont intacts depuis l'étape 2.
- **`appliquerDegats(horde, slot, brut, zones, tick, dead)` est le SEUL chemin** par lequel un ennemi
  perd des PV, et l'armure comme l'amplification y sont dérivées **dedans**.
- **Le test de dérivation de `shared/projectiles.ts` reste intact et indépendant de la horde.**
- **La marque reste cosmétique côté client** (`GameClient#markLocally`). Aucun effet ne roule dessus.
- **Français sans accents dans les commentaires de code**, avec accents dans les documents.
- Commits : minuscules, type dans `build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test`,
  terminés par `Claude-Session: <url de session>`.
- **Committer AVANT la campagne de mutations** — elle restaure par `git checkout`, qui efface le
  travail non commité.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : les serveurs de dev tournent sur 5173
  et 3100.
- **Lancer les vérifications au PREMIER PLAN.** Trois sous-agents de l'étape 5b se sont bloqués en
  attendant une notification d'arrière-plan qui n'est jamais venue.

## Le piège d'ordre, qui vaut pour CHAQUE tâche de contenu

⚠️ **Une zone de réaction porte, dans ses bits d'élément, celui du DÉCLENCHEUR** — donc du projectile
arrivé **second** (`ReactionTrigger.element` et son docbloc). Toute grandeur de zone dérivée de
l'élément seul est donc **dépendante de l'ordre d'arrivée**.

L'étape 5b a payé ça **deux fois** :

| Occurrence | Ce qui s'est passé |
| --- | --- |
| `ZoneField.spawn` fusionnait sur l'élément et ne réécrivait pas l'octet | **bug de production** : deux mêmes objets, deux ordres, deux résultats opposés |
| `zoneSlowFactor` a dû être créé | sans lui, la même Supraconduction gelait ou pas selon qui était arrivé second |

**Règle pour cette étape : toute nouvelle grandeur de zone porte sa valeur EXPLICITEMENT au niveau de
la réaction, et son test pose les DEUX ordres et assène l'égalité.** `shared/reactions.ts` porte déjà
six dériveurs de cette forme (`zoneLifetimeTicks`, `zoneBurnPerTick`, `zoneSlowFactor`,
`zoneArmorReduction`, `zoneInertiaDamping`, `zoneCollisionDamage`) — **suis-les, n'invente pas une
septième forme.**

## Les combinaisons se prennent au MAXIMUM, sauf une

Quatre grandeurs de zone se combinent par **maximum** et portent chacune leur test « ne cumulent
pas » : `ampAt`, `armorReductionAt`, `collisionDamageAt`, `burnAt`. **Toute nouvelle grandeur de cette
étape les rejoint**, et son test appartient à la même famille dans `shared/zones.test.ts`.

⚠️ **L'étape 5b a appris ça au prix d'un bug** : `burnAt` était la seule grandeur à **sommer** — quatre
champs superposés faisaient 72 PV/s, une piétaille lourde en 0,28 s — et c'était la seule sans test
« ne cumulent pas ».

Le **minimum** de `Horde#computeSlow` reste à part, et sa raison est **arithmétique**, pas de jeu :
*« le minimum est commutatif et associatif exactement ; un produit de flottants ne l'est pas »*, parce
que l'ordre d'itération n'est pas garanti identique des deux côtés. **Ne pas confondre les deux
raisons dans les commentaires.**

## Points de revue

Cinq classes d'entrée que la spec implique et qu'aucune tâche n'exercerait sans ça. Chacune reçoit son
test dans la tâche qui possède le code.

1. **Une zone de Chaux ET une de Fournée sur le même ennemi.** L'armure doit tomber à zéro, pas en
   dessous. `armureA` est déjà bornée par `Math.max(0, …)` — le test doit l'épingler, sinon la borne
   n'est gardée par rien. → tâche 4.
2. **Un ennemi est-il lié à lui-même ?** Le rayon de liaison inclut sa propre position, à distance
   nulle. → tâche 2.
3. **Paratonnerre quand AUCUN ennemi n'est lié.** `exclude` contient alors tout le monde : la chaîne
   doit rendre une liste vide, pas boucler ni lever. → tâche 5.
4. **Un ennemi sous Chaux (fuite) ET Supraconduction (vitesse nulle).** Le minimum donne 0 : le gel
   gagne et la fuite devient sans objet. Le test doit dire lequel gagne, sinon un lecteur futur
   inversera. → tâche 6.
5. **`ZONE_CAPACITY` avec quinze `kind` distincts.** Deux zones de `kind` différent ne fusionnent plus
   depuis 5b ; quinze réactions multiplient les `kind`. 5b a mesuré 25 % d'occupation avec six.
   → tâche 9.

---

## Tâche 1 : la Chaux, ses deux moitiés, et les dérivations qui survivent à l'ordre

**Fichiers :** modifier `shared/elements.ts`, `shared/reactions.ts`, `shared/zones.ts`,
`shared/horde.ts`, `shared/constants.ts`, leurs tests

- [ ] **Étape 1 : la ligne dans `ELEMENT_DEFS`**, et `ELEMENT.CHAUX = 5`. `elements.test.ts` vérifie
  que chaque clé de `ELEMENT` pointe sur l'élément du même nom — **ne casse pas cette garde** en
  insérant une ligne.

  `burnPerTick: 0`, `slowFactor: 1`, `damageAmp: 1`. La Chaux n'agit ni par la brûlure, ni par le
  ralentissement, ni par l'amplification.

- [ ] **Étape 2 : `Element.armorReduction`** — nouveau champ, à `0` pour les cinq éléments existants.
  La Chaux est le premier élément à réduire l'armure par lui-même ; jusqu'ici seule une réaction le
  faisait (`ReactionDef.zoneArmorReduction`, Supraconduction).

- [ ] **Étape 3 : `armorReductionAt` combine élément ET réaction.** Aujourd'hui elle ne lit que
  `zoneArmorReduction(kind)`. Elle doit désormais dériver comme `zoneSlowFactor` le fait pour la
  vitesse — **un dériveur dans `shared/reactions.ts`, du même nom de famille** :

  ```ts
  /**
   * La reduction d'armure qu'une zone impose, element ET reaction confondus.
   *
   * ⚠️ **Meme raison d'etre que `zoneSlowFactor`** : le nibble d'element d'une
   * zone de reaction porte celui du DECLENCHEUR, qui varie selon l'ordre
   * d'arrivee. Deriver de l'element seul rendrait l'effet dependant de cet
   * ordre — le bug que l'etape 5b a paye deux fois.
   */
  export function zoneArmorReductionTotal(kind: number): number
  ```

  **Un MAXIMUM entre les deux contributions**, pas une somme : deux sources de corrosion ne
  s'additionnent pas, comme deux flaques de Poix n'additionnent pas leur amplification.

- [ ] **Étape 4 : le test de l'ordre, et c'est LE test de l'étape 3.**

  ```ts
  it('la reduction d armure d une zone ne depend pas de l ordre d arrivee', () => {
    // La meme reaction, les deux ordres de declencheur : meme reduction.
    // Sans ce test, une zone de Fournee corroderait ou pas selon que la
    // Braise ou la Chaux a touche en second.
    const a = zoneArmorReductionTotal(packZoneKind(ELEMENT.BRAISE, REACTION.FOURNEE));
    const b = zoneArmorReductionTotal(packZoneKind(ELEMENT.CHAUX, REACTION.FOURNEE));
    expect(a).toBe(b);
    // ⚠️ Et une garde de non-vacuite : si les deux valaient 0, l'egalite
    // serait vraie et ne prouverait rien.
    expect(a).toBeGreaterThan(0);
  });
  ```

- [ ] **Étape 5 : la fuite — une substitution de direction, pas une écriture.**

  ⚠️ **`Horde#retarget` recalcule `targetField` à CHAQUE tick** depuis les positions des joueurs
  (`shared/horde.ts:742`). Toute écriture y serait écrasée au tick suivant. La fuite est donc une
  **inversion du vecteur de champ** dans la boucle de déplacement, là où `fx`/`fy` sont lus
  (`shared/horde.ts` ~1442), dérivée de l'appartenance à la zone.

  Un dériveur de la même famille, et **son signe porté explicitement par la réaction** :

  ```ts
  /** `-1` : la zone inverse la direction du champ. `+1` : elle ne la touche pas. */
  export function zoneFieldSign(kind: number): number
  ```

- [ ] **Étape 6 : le test de réplication, étendu et non réécrit.** `shared/horde.replication.test.ts`
  porte déjà ZF0/ZF1/ZF2 (Supraconduction) et VF0/VF1/VF2 (Verglas). Ajoute **CF0/CF1/CF2** :

  - **CF0** — la fuite mord : écart non nul entre une horde en zone de Chaux et un témoin neutre ;
  - **CF1** — **sans** rejeu : dérive non nulle ;
  - **CF2** — **avec** rejeu : **0,000 px**.

  ⚠️ **Une mesure qui ne sait produire que 0,000 px ne mesure pas.** C'est pour ça que ce fichier
  garde ses 430,569 px et 544,360 px à côté de ses zéros.

- [ ] **Étape 7 : commit** — `feat(shared): la chaux corrode et fait fuir`

---

## Tâche 2 : le Vif-argent, et la liaison dérivée

**Fichiers :** modifier `shared/elements.ts`, `shared/constants.ts` ; créer `shared/links.ts` ; leurs tests

- [ ] **Étape 1 : la ligne dans `ELEMENT_DEFS`**, `ELEMENT.VIF_ARGENT = 6`, tous les effets de table à
  leur neutre. L'effet du Vif-argent ne vit pas dans la table — comme celui de la Foudre, dont
  `shared/elements.test.ts` porte l'exception nommée `EFFET_HORS_TABLE`. **Ajoute le Vif-argent à cette
  exception, et dis dans ton rapport si son prédicat mérite d'être élargi plutôt qu'exempté** — c'est
  ce que la tâche 9 de l'étape 5b a fait pour la Poix.

- [ ] **Étape 2 : `LINK_RADIUS` dans `shared/constants.ts`**, avec son repère en commentaire face à
  `ZONE_RADIUS = 70`, `REACTION_RADIUS = 90` et `CHAIN_RADIUS = 150`. **Valeur de départ, à régler à
  l'œil** — la spec §11 le dit.

- [ ] **Étape 3 : le test qui échoue d'abord — et il porte le point de revue n° 2.**

  ```ts
  it('un ennemi n est pas lie a lui-meme', () => {
    // Son propre centre est a distance NULLE, donc dans tout rayon. Sans
    // exclusion explicite, chaque ennemi serait lie a lui-meme et Amalgame
    // (tache 7) le frapperait deux fois.
  });

  it('la liaison n est PAS transitive', () => {
    // A-B a moins de LINK_RADIUS, B-C a moins de LINK_RADIUS, A-C au-dela.
    // A et C ne sont PAS lies. Une fermeture transitive serait un parcours de
    // graphe, dont le resultat depend de l'ordre de visite — or cet ordre
    // depend du compactage de la horde, qui n'est PAS garanti identique des
    // deux cotes du fil.
  });
  ```

  ⚠️ **Ce second test est le cœur de la tâche.** C'est la troisième rencontre de ce piège dans le
  projet : la chaîne de la Foudre l'a résolu par un départage sur `entityId`, *Embrasement* est devenu
  un rayon, la liaison devient un rayon aussi.

- [ ] **Étape 4 : `shared/links.ts`** — dans `shared/`, parce que **les deux côtés l'appellent** : le
  serveur pour les dégâts, le client pour d'éventuels effets dérivés.

  ```ts
  /**
   * Les voisins LIES d'une entite : ceux qui partagent une zone de Vif-argent
   * avec elle et sont a moins de `LINK_RADIUS`.
   *
   * ⚠️ **Deterministe et NON TRANSITIVE.** Les positions de la horde sont
   * bit-identiques des deux cotes et les zones sont annoncees : la meme entree
   * rend la meme sortie, sans qu'aucune relation ne voyage. Mais une fermeture
   * transitive serait un parcours de graphe, dont le resultat depend de
   * l'ordre de visite — voir le test.
   *
   * ⚠️ **L'entite elle-meme n'est JAMAIS dans le resultat.**
   */
  export function linkedNeighbours(
    horde: Horde,
    slot: number,
    zones: ZoneField,
    tick: number,
  ): number[]
  ```

- [ ] **Étape 5 : commit** — `feat(shared): le vif-argent lie les ennemis proches`

---

## Tâche 3 : le rayon de touche élargi — cinquième de la famille maximum

**Fichiers :** modifier `shared/zones.ts`, `shared/reactions.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : `ZoneField.hitRadiusBonusAt(x, y, tick)`**, cinquième méthode de la famille, à côté
  d'`ampAt`, `armorReductionAt`, `collisionDamageAt` et `burnAt`. **Combinée par MAXIMUM.**

  ⚠️ **La raison est de JEU**, pas arithmétique : deux zones de Vif-argent qui se recouvrent ne
  doublent pas le rayon. Le **minimum** de `#computeSlow` a une raison arithmétique, et les confondre
  dans un commentaire est le défaut que l'étape 5b a corrigé à la main.

- [ ] **Étape 2 : le quatrième test de la famille « ne cumulent pas »**, dans `shared/zones.test.ts`
  avec ses quatre sœurs. **Deux décors**, comme celui de `burnAt` :
  - deux zones de **même** réaction à **déclencheurs opposés** ;
  - deux zones de même `kind`, centres écartés de **1,2 × `ZONE_RADIUS`** (disques recouverts, pas de
    fusion).

  ⚠️ **Et pose-les dans les DEUX ordres.** `burnAt` ne le fait que dans un seul — asymétrie relevée à
  la re-revue finale de 5b. Ne la reproduis pas.

- [ ] **Étape 3 : le brancher côté serveur seul.** `PROJECTILE_HIT_RADIUS = 32` est majoré pour un
  ennemi en zone, au site où la collision est résolue.

  ⚠️ **Le contrat des projectiles ne bouge pas.** `shared/projectiles.ts` porte un second contrat de
  réplication : *« la salve reste calculée identiquement des deux côtés à partir de la même direction
  quantifiée »*, verrouillé par un test de dérivation. Une trajectoire continue de ne dépendre que de
  l'arme, du tick, de la position du tireur et de la direction quantifiée. **Si ta modification fait
  entrer la horde ou les zones dans ce calcul, tu as pris le mauvais chemin — arrête et dis-le.**

- [ ] **Étape 4 : solder un contrat gardé sur le mauvais chemin.**

  ⚠️ **Vérifié en écrivant ce plan** : `describe('Projectiles — derivation')`
  (`shared/projectiles.test.ts:378`) appelle **`fireSalvo`** — la visée par cible, qui prend la horde
  en paramètre — et **zéro fois `fireSalvoDirected`**, le seul chemin que la production utilise depuis
  la tâche 13 de l'étape 6a (`room.ts:1526`, `client.ts:2190`). Le contrat est réel ; **le test garde
  une fonction que le jeu n'appelle plus.**

  Deux tests, et le second est le vrai :

  ```ts
  it('fireSalvoDirected derive identiquement des deux cotes', () => {
    // Le MEME scenario que le test de derivation existant, mais sur le chemin
    // de PRODUCTION. Deux instances independantes, memes armes, memes ticks,
    // meme direction quantifiee : memes salves.
  });

  it('une trajectoire ne depend NI de la horde NI des zones', () => {
    // ⚠️ Deux instances avec des hordes DIFFERENTES et des zones DIFFERENTES
    // — d'un cote des zones de Vif-argent, de l'autre aucune — et des
    // trajectoires IDENTIQUES.
    //
    // Le test existant ne prouve pas ca : ses deux cotes construisent la MEME
    // horde, donc il prouve le determinisme a horde egale, pas
    // l'INDEPENDANCE. C'est la difference entre « meme entree, meme sortie »
    // et « cette entree n'en est pas une ».
  });
  ```

  ⚠️ **Garde de non-vacuité** : assertionne que les deux côtés portent réellement des projectiles
  vivants à la fin, et que les hordes sont réellement différentes. Le test existant le fait déjà pour
  les projectiles (« ni multiple de `SINGLE.cooldownTicks` ni de `SPREAD.cooldownTicks` ») — suis ce
  réflexe.

- [ ] **Étape 5 : commit** — `feat: un ennemi lie est plus facile a toucher`

---

## Tâche 4 : Fournée et Éclat de gel

**Fichiers :** modifier `shared/reactions.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : deux lignes dans `REACTION_DEFS`.** `REACTION.FOURNEE = 6`,
  `REACTION.ECLAT_DE_GEL = 7`.

- [ ] **Étape 2 : Fournée (Braise + Chaux)** — la combustion **double**, et l'armure **tombe à zéro**
  dans la zone : `zoneBurnPerTick` élevé, `zoneArmorReduction` porté à `MAX_ARMOR` (0,9) ou au-delà.

  ⚠️ **« Ignore l'armure » ne doit PAS contourner `appliquerDegats`.** Le §6.4 écrit *« ignore
  l'armure »* ; un chemin qui sauterait la fonction serait **un second chemin**, exactement ce que
  « un seul chemin » existe pour empêcher — et le docbloc de `damageInRadius` porte déjà la trace de
  cette erreur commise une fois à l'étape 5b. `armureA` est déjà bornée par
  `Math.max(0, base - reduction)` : il n'y a **rien à ajouter**, seulement une valeur à choisir.

- [ ] **Étape 3 : le point de revue n° 1.**

  ```ts
  it('une zone de Chaux ET une de Fournee ne poussent pas l armure sous zero', () => {
    // L'armure effective vaut exactement 0, jamais un negatif — qui
    // MAJORERAIT les degats au lieu de les laisser bruts.
    // ⚠️ Decor a PV eleves : une cible qui meurt au premier coup rendrait
    // l'assertion vraie a vide (le defaut que la re-revue finale de 5b a
    // trouve sur `hp = 0.05`).
  });
  ```

- [ ] **Étape 4 : Éclat de gel (Givre + Chaux)** — dégâts bruts massifs sur une cible. `damage` élevé,
  `radius: 0`. **Assène la perte exacte**, pas un `toBeLessThan` : l'étape 5b a laissé passer
  `def.damage * 3` sur 214 tests verts avec des assertions molles.

- [ ] **Étape 5 : commit** — `feat: fournee et eclat de gel`

---

## Tâche 5 : Vaporisation, Arc caustique, Paratonnerre

**Fichiers :** modifier `shared/reactions.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : trois lignes dans `REACTION_DEFS`.** `REACTION.VAPORISATION = 8`,
  `REACTION.ARC_CAUSTIQUE = 9`, `REACTION.PARATONNERRE = 10`.

- [ ] **Étape 2 : Vaporisation (Braise + Vif-argent)** — dégâts dans un rayon autour des ennemis
  **liés**. Réutilise `damageInRadius` avec son `markFilter`, et `linkedNeighbours` de la tâche 2.
  **N'écris pas un second balayage** : la re-revue finale de 5b a fondu les deux qui existaient, et le
  docbloc de `damageInRadius` raconte désormais pourquoi.

- [ ] **Étape 3 : Arc caustique (Foudre + Chaux)** — la chaîne laisse un champ corrosif à chaque saut.
  `chainTargets` **inchangée**, plus une pose de zone par cible touchée.

- [ ] **Étape 4 : Paratonnerre (Foudre + Vif-argent)** — la chaîne **préfère les ennemis liés** :
  `exclude` pré-rempli des **non-liés**, exactement la forme que Court-circuit a prise pour les
  non-poissés à l'étape 5b. **Ne crée pas une seconde fonction de chaîne.**

- [ ] **Étape 5 : le point de revue n° 3.**

  ```ts
  it('Paratonnerre ne boucle pas quand AUCUN ennemi n est lie', () => {
    // `exclude` contient alors toute la horde : `chainTargets` doit rendre
    // une liste VIDE, sans boucler ni lever.
    // ⚠️ Et une garde de non-vacuite : la horde doit etre REELLEMENT peuplee,
    // sinon le test passe tout seul — « le test qui renvoie zero », cinq
    // occurrences dans ce depot.
  });
  ```

- [ ] **Étape 6 : commit** — `feat: vaporisation, arc caustique, paratonnerre`

---

## Tâche 6 : Gel profond, Mortier vif, Aveuglement

**Fichiers :** modifier `shared/reactions.ts`, `shared/horde.ts`, leurs tests, `shared/horde.replication.test.ts`

- [ ] **Étape 1 : trois lignes dans `REACTION_DEFS`.** `REACTION.GEL_PROFOND = 11`,
  `REACTION.MORTIER_VIF = 12`, `REACTION.AVEUGLEMENT = 13`.

- [ ] **Étape 2 : Gel profond (Givre + Vif-argent)** — `zoneSlowFactor: 0`, **plus longue** que la
  Supraconduction (`zoneLifetimeTicks` supérieur).

  ⚠️ **Gel profond doit être DISTINGUABLE de la Supraconduction, sinon c'est du contenu mort.** Les
  deux gèlent ; seule la durée les sépare. Ton test doit assener **quelle** durée, pas seulement que
  les deux gèlent.

- [ ] **Étape 3 : Mortier vif (Poix + Chaux)** — `zoneSlowFactor: 0` **et** amplification : scellés et
  fragiles. Deux grandeurs de zone sur la même réaction, chacune portée **explicitement**.

- [ ] **Étape 4 : Aveuglement (Chaux + Vif-argent)** — la fuite, **plus forte ou plus longue** que la
  Chaux seule. `zoneFieldSign: -1` porté explicitement, jamais hérité de l'élément.

  ⚠️ **Écart au §6.4 assumé, et sa raison doit être ÉCRITE dans la table** : le §6.4 dit *« perdent
  leur cible et **errent** »*. Une horde qui erre perd sa pression, et la pression est la tension du
  genre. Sans la raison dans la table, quelqu'un « corrigera » l'écart dans six mois.

- [ ] **Étape 5 : le point de revue n° 4.**

  ```ts
  it('un ennemi sous Chaux ET Supraconduction est GELE, pas en fuite', () => {
    // `#computeSlow` prend le MINIMUM : 0 gagne, donc la fuite devient sans
    // objet. Dire lequel gagne, sinon un lecteur futur inversera.
    // Poser les deux zones dans les DEUX ordres.
  });
  ```

- [ ] **Étape 6 : étendre `shared/horde.replication.test.ts`** — un scénario avec rejeu à **0,000 px**
  et son chiffre non nul sans rejeu, pour les trois réactions de déplacement de cette tâche.

- [ ] **Étape 7 : commit** — `feat: gel profond, mortier vif, aveuglement`

---

## Tâche 7 : Amalgame — la seule réaction structurellement neuve

**Fichiers :** modifier `shared/reactions.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : `REACTION.AMALGAME = 14`.** C'est la quinzième et dernière valeur du nibble — **il
  en reste une**. Dis-le en commentaire : une seizième réaction demanderait un octet.

- [ ] **Étape 2 : les dégâts subis par un ennemi lié frappent aussi ses voisins.**

  ⚠️ **Dans un RAYON, pas sur un amas.** Écart assumé au §6.4, même raison qu'*Embrasement* : une
  fermeture transitive est un parcours de graphe, dont le résultat dépend de l'ordre de visite.

  ⚠️ **Tout passe par `appliquerDegats`**, et la compaction reste **dehors**, après tous les dégâts —
  c'est déjà la règle de `damageInRadius`, et la casser ferait sauter des indices en plein parcours.

- [ ] **Étape 3 : le test qui garde l'absence de récursion.**

  ```ts
  it('Amalgame ne se propage pas en cascade', () => {
    // A lie a B, B lie a C. Un coup sur A frappe B (rayon), mais le coup
    // recu par B ne doit PAS repartir vers C. Sans cette garde, deux ennemis
    // lies se renvoient les degats jusqu'a la pile.
  });

  it('deux ennemis lies qui meurent du meme Amalgame ne comptent qu une fois chacun', () => {
    // Les morts passent par le `DEATHS` existant, et `dead` est un Set :
    // assene-le plutot que de l'esperer.
  });
  ```

- [ ] **Étape 4 : commit** — `feat(back): amalgame partage les degats entre ennemis lies`

---

## Tâche 8 : les armes

**Fichiers :** modifier `shared/weapons.ts`, ses tests

- [ ] **Étape 1 : au moins DEUX armes par nouvel élément.** Le pool passe de 13 à ~17. En dessous de
  deux, l'élément ne se draftera qu'accidentellement et l'étape ne se jugera pas.

- [ ] **Étape 2 : chaque arme a une apparence DISTINCTE.** `Weapon.look` est obligatoire et la garde
  est machine — `assertWeaponLooks`, plus un test de rendu qui compare au compte **dynamique** de
  `WEAPONS`. À 13 armes elle a déjà attrapé une collision de diamètre.

- [ ] **Étape 3 : `assertWeaponElements` vérifie au CHARGEMENT du module.** Ne la contourne pas : une
  référence morte ne se verrait qu'au premier tir, plusieurs tâches plus tard.

- [ ] **Étape 4 : vider l'exception `EFFET_HORS_TABLE`** si le Vif-argent y était (tâche 2), ou dire
  pourquoi elle reste — avec une raison **structurelle**, pas une dette de tâche.

- [ ] **Étape 5 : commit** — `feat(shared): quatre armes pour la chaux et le vif-argent`

---

## Tâche 9 : le banc, peuplé de LOURDS

**Fichiers :** modifier `back/bench/elements.bench.ts`

- [ ] **Étape 1 : le coût de la liaison.** `linkedNeighbours` est naïvement en `O(n²)` sur les ennemis
  en zone. Pas p95 sous **11,11 ms** à 4 000 entités, quatre joueurs portant le Vif-argent.

  Issue engagée d'avance : si le p95 dépasse, la liaison passe par la **grille de voisinage** qui sert
  déjà à la séparation.

- [ ] **Étape 2 : le point de revue n° 5 — `ZONE_CAPACITY` avec quinze `kind`.** C'est **la mesure la
  plus susceptible de mal tourner de toute l'étape**. 5b a mesuré **25 %** d'occupation en régime
  soutenu avec six réactions, `truncatedZones` à zéro ; quinze multiplient les `kind` distincts, et
  deux zones de `kind` différent **ne fusionnent pas**.

  ⚠️ **Ne l'extrapole pas.** 5b a démenti une extrapolation de 13-19 % par une mesure à 25 %. `Room`
  expose déjà `truncatedZones` (cumulatif) et `zoneCount` (instantané) — **n'écris pas un troisième
  instrument.**

- [ ] **Étape 3 : peuplé de LOURDS**, et le banc **assertionne** que son décor l'est. Le banc `zones` a
  menti une fois en étant peuplé de piétaille légère, qui meurt au premier impact.

- [ ] **Étape 4 : engage le verdict**, comme le banc `boss` imprime `VERDICT : 59.0 s, dans la bande
  30-90 s -> ON GARDE`. Un banc qui imprime des chiffres sans dire ce qu'ils décident laisse la
  décision à l'humeur du lecteur.

- [ ] **Étape 5 : mute ton propre banc.** Un décor qui ne peuple pas, un compteur qui ne compte pas,
  un verdict qui ne juge pas.

- [ ] **Étape 6 : commit** — `test(back): le banc des six elements`

---

## Tâche 10 : quatre clients — le livrable, et le pitch enfin testable

**Fichiers :** créer `back/src/elements-5c.integration.test.ts`

- [ ] **Étape 1 : le harnais existe.** `draft`, `elements`, `portal` et `elements-5b`
  `.integration.test.ts` — quatre vraies sockets, `buildServer({ roomSeed })`, `app.rooms`, monstres
  posés à la main, `port: 0` éphémère. **Réutiliser, ne pas réinventer.**

- [ ] **Étape 2 : ce que le test doit assener :**
  - **quatre joueurs couvrant les six éléments déclenchent les quinze réactions** ;
  - **un joueur seul, quatre slots, ne peut en couvrir que six** — c'est le pitch du README, testable
    pour la première fois ;
  - le **trafic par joueur ne bouge pas**, mesuré au niveau socket, **dans les deux sens** (un salon
    où Chaux et Vif-argent ne tirent jamais, un salon où elles tirent, et le second produit des paires
    **nouvelles** — sinon l'égalité compare deux ensembles vides).

- [ ] **Étape 3 : les deux moitiés.** Assène **quelle** réaction, et qu'une paire qui ne doit rien
  produire ne produise **rien**, en comparant deux listes champ à champ.

  ⚠️ **Et assène `synergyCharge`.** Le livrable de 5b ne le lisait pas dans son scénario à quatre
  joueurs : la mutation « la Synergie ne charge jamais » — la règle que le code appelle *« le cœur du
  projet »* — laissait ses trois tests verts.

- [ ] **Étape 4 : un décor DÉTERMINISTE.** Le livrable de 5b échouait **2 fois sur 13** parce qu'un
  joueur portait deux éléments et tirait seul : quand ses deux projectiles atterrissaient dans le même
  pas, la réaction cessait d'être inter-joueurs. **Aucun joueur ne doit être la seule source des deux
  éléments d'une paire qu'il déclenche.** Lance la suite complète **cinq fois** et donne les cinq
  résultats.

- [ ] **Étape 5 : NE mesure PAS la réplication ici.** Établi à l'étape 6a et vérifié : le décor d'un
  test d'intégration balaie la horde par `Horde.kill`, qui **court-circuite volontairement le lot
  `DEATHS`** — un client qui dériverait sa horde du fil divergerait **par construction**. Les chiffres
  vivent dans `shared/horde.replication.test.ts`.

- [ ] **Étape 6 : commit** — `test(back): six elements, quinze reactions, zero octet de plus`

---

## Tâche 11 : vérification manuelle et clôture

- [ ] **Jouer une run entière.** Ce que rien n'automatise :
  - **quinze réactions, est-ce lisible ?** Un joueur peut-il savoir ce qui vient de se produire ?
  - *Gel profond* se distingue-t-il de la **Supraconduction** ? *Aveuglement* de la **Chaux seule** ?
  - la Chaux qui **disperse** se comprend-elle, à côté d'*Amalgame* et *Mortier vif* qui rassemblent ?
  - le rayon de touche élargi **se sent**-il comme de l'attraction, ou comme rien ?
  - six éléments et quatre slots : le **draft** a-t-il enfin un enjeu ?

- [ ] **Rejouer les bancs À FROID**, aucun sous-agent en vol. À l'étape 5b, un relevé pris sous charge
  concurrente a fait conclure à tort que la variance était intrinsèque.

- [ ] Écrire `docs/plans/2026-09-26-etape-5c-resultats.md`, mettre à jour le `README.md`.

- [ ] **Commit** — `docs: resultats de l'etape 5c`

---

## Auto-relecture

**Couverture de la spec.** §1 le périmètre → tâches 1 à 8 ; §1.1 le volume sans le risque → la
répartition des tâches 4 à 7 ; §1.2 les deux contrats → tâches 1 (horde) et 3 (projectiles) ; §2 la
Chaux → tâche 1 ; §3 la liaison → tâche 2 ; §4 le rayon élargi → tâche 3 ; §5 les neuf réactions →
tâches 4 à 7 ; §6 le maximum → tâche 3 étape 2 ; §7 les armes → tâche 8 ; §8 la porte → tâche 9 ;
§9 la vérification → tâches 10 et 11 ; §10 les écarts → inscrits dans les tâches 4, 6 et 7 ; §11 les
questions ouvertes → tâche 11.

**Les deux endroits où ce plan a le plus de chances de se tromper**, nommés plutôt que cachés :

1. **~~La tâche 3 touche un contrat que je n'ai jamais vérifié moi-même.~~ Vérifié, et c'était pire
   que ma méfiance.** Le test de dérivation existe mais garde `fireSalvo`, abandonné par la production
   à la tâche 13 de l'étape 6a ; et ses deux côtés construisent la **même** horde, donc il prouve le
   déterminisme à horde égale, **pas** l'indépendance. L'étape 4 de la tâche 3 le solde, et c'est
   devenu la partie la plus utile de cette tâche.
2. **`zoneFieldSign` est ma proposition, pas celle de la spec.** La spec dit « la direction du champ
   est inversée » sans nommer le mécanisme. Si l'implémenteur trouve une forme qui n'a pas besoin d'un
   septième dériveur — par exemple en faisant porter l'inversion par le facteur de vitesse existant,
   avec un signe — **qu'il le signale au lieu de choisir en silence**.

**Cohérence des types.** `zoneArmorReductionTotal(kind)` est définie à la tâche 1 et consommée par
`armorReductionAt`. `zoneFieldSign(kind)` est définie à la tâche 1 et consommée par `#computeSlow` ou
la boucle de déplacement. `linkedNeighbours(horde, slot, zones, tick)` est définie à la tâche 2 et
consommée aux tâches 5 et 7. `hitRadiusBonusAt(x, y, tick)` est définie à la tâche 3 et consommée par
la résolution de collision. `appliquerDegats(horde, slot, brut, zones, tick, dead)` et
`chainTargets(horde, cx, cy, radius, jumps, exclude)` **ne changent pas de signature**. **`Horde` ne
gagne aucun tableau** : la liste des quatorze à tenir à jour dans `#removeAt` / `spawn` / `saveState` /
`restoreState` ne bouge pas.
