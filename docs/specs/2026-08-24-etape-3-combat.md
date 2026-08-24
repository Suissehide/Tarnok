# Tarnok — étape 3 : le combat

Spec de l'étape 3 du §13 de
[`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md).
Les références en `§` sans autre précision renvoient à ce document d'orientation.

**Livrable vérifiable seul : une run solo jouable de bout en bout.** On commence, on tire,
les ennemis meurent, on monte de niveau, on finit par mourir, et un bilan s'affiche.

L'étape 2 a prouvé qu'une horde peut être répliquée par son générateur. Celle-ci lui ajoute
tout ce qui la rend mortelle — et, ce faisant, met ce contrat de réplication à l'épreuve
d'une façon qu'il n'a encore jamais subie : **les entités vont disparaître.**

---

## 1. Périmètre

### Dans l'étape

- **Armes** pilotées par la donnée, dont l'arme neutre de base du §6.1.
- **Projectiles** simulés localement, **dérivés** plutôt que répliqués (§5.2).
- **Dégâts et morts** arbitrés par le serveur, diffusés groupés par tick (§3).
- **Séparation** entre entités (§4).
- **Expérience globale**, montée de niveau, et le **gel** du monde du §7.4.
- **Dégâts au joueur**, mort, et bilan de fin de run.

### Hors de l'étape, et pourquoi

| Exclu | Renvoyé à | Raison |
| --- | --- | --- |
| L'étalage de cartes | étape 4 | C'est le cœur social du jeu (§7) ; l'avancer à moitié le viderait de sa négociation. Le **gel** est câblé ici, l'étalage s'y branchera. |
| Les classes et leurs verbes | étape 4 | Le §15.1 demandait de trancher avant l'étape 3 ; une classe n'apporte qu'un verbe et un trait, jamais une arme (§6.7). Rien dans le combat n'en dépend. |
| Éléments et réactions | étape 5 | Les armes de cette étape sont neutres. |
| Élites et boss | étape 6 | Régime de réplication différent (§3.3). |
| Réanimation, forme fantôme | étape 8 | Mécaniques dont l'intérêt est entièrement coopératif (§8.2) ; en solo, personne ne relève. |

---

## 2. Ce que cette étape fait courir au contrat de réplication

L'étape 2 a mesuré une propriété qui gouverne toute la suite : **une différence d'un seul
tick entre deux simulations ne se résorbe pas, elle s'amplifie linéairement** — 694 px après
dix secondes, sans borne. La cause est le flowfield, champ de directions discret dont les
frontières de cellules rendent les trajectoires sensibles aux conditions initiales.

Cette étape ajoute **deux nouvelles sources de différence**, et la seconde est bien plus
dangereuse que la première.

**La mort arrive en retard.** Le serveur tue au tick `T` ; le client l'apprend à `T + L`.
Entre les deux, le client simule un mort.

**Et la séparation couple les entités entre elles.** C'est le point qu'aucun document
antérieur n'anticipait. Jusqu'ici, chaque ennemi suivait le flowfield indépendamment :
retirer son voisin ne changeait rien à sa trajectoire. Dès qu'ils se poussent, **retirer une
entité déplace tous ses voisins** — et par propagation, de proche en proche, une part
arbitraire de la horde.

Une mort appliquée un tick trop tard ne décale donc plus une entité : elle en décale des
dizaines. C'est ce qui justifie le mécanisme du §3.2.

---

## 3. Les morts

### 3.1 Sur le fil

Un seul message nouveau, **groupé par tick** comme le prescrit le §3.3 :

| Champ | Type | Rôle |
| --- | --- | --- |
| `tick` | `u32` | tick auquel ces morts ont eu lieu |
| `count` | `u16` | nombre de morts |
| `entityId` | `u32` × count | identités, **triées par ordre croissant** |

L'identité est arithmétique depuis l'étape 2 (`waveId × MAX_PER_WAVE + index`), donc un
`u32` suffit et **aucune table de correspondance n'est à synchroniser** — donc aucune à
désynchroniser.

Volume : à trois morts par tick, ~570 o/s. Sur un pic de cent morts simultanées, 407 octets
une fois. La mesure de l'étape 2 donne 0,47 ko/s par joueur contre 5 à 15 estimés au §3.3 :
la marge absorbe largement.

**Le tri par identifiant croissant n'est pas cosmétique.** Il rend l'ordre d'application
canonique, donc la compaction des tableaux identique partout. Sans lui, deux clients
retireraient les mêmes entités dans un ordre différent, leurs tableaux ne seraient plus
alignés, et l'indice `i` cesserait de désigner la même entité — l'invariant exact que le
test de réplication de l'étape 2 vérifie par comparaison d'identités.

### 3.2 Le retour en arrière, côté client

Le client conserve l'état de sa horde sur les derniers ticks. En recevant des morts datées
du tick `T` :

1. il restaure l'état de `T` ;
2. il applique les morts, dans l'ordre canonique ;
3. il rejoue les ticks jusqu'au présent.

**Le serveur ne revient jamais en arrière.** Il est autoritaire, il décide au présent. Seuls
les clients rejouent — l'asymétrie est délibérée et elle simplifie tout : il n'existe qu'une
seule vérité, et elle n'est jamais révisée.

**Si les morts datent d'un tick sorti de l'historique**, le client les applique au présent et
**le signale** plutôt que de le taire. Une dégradation silencieuse est un piège ; c'est la
leçon de la troncature muette de l'étape 2.

### 3.3 Ce que ce rejeu coûte, et pourquoi le plan commence par une mesure

Rejouer `L` ticks, c'est payer `L + 1` fois le coût d'un pas de simulation — **à chaque
tick, en permanence**.

L'étape 1 a mesuré le déplacement seul : **0,02 ms pour 4 000 entités**, négligeable. Mais
**la séparation n'a jamais été mesurée**, et c'est elle qui dominera. Si elle coûte 1 ms, le
rejeu en coûte 4, soit un quart d'une image à 60 fps — et c'est avant tout le reste.

**Le plan commencera donc par un spike qui mesure la séparation et le rejeu**, exactement
comme l'étape 2 a commencé par vérifier que `ParticleContainer` savait animer, et comme
l'étape 1 tout entière était une porte. Selon le chiffre :

| Si la mesure dit… | Alors |
| --- | --- |
| rejeu < 1 ms à 1 500 entités | on garde le mécanisme tel quel |
| 1 à 4 ms | on borne la profondeur de rejeu et on mesure la dérive résiduelle |
| > 4 ms | **on rouvre le §3.2** : séparation moins chère, ou morts appliquées au présent avec dérive mesurée |

Le troisième cas n'est pas un échec. C'est la raison d'être du spike.

---

## 4. La séparation

**Grille spatiale uniforme**, cellules d'environ deux fois le rayon d'une entité. Chaque
entité est repoussée par celles de sa cellule et des huit adjacentes. Coût en
`O(entités × voisins)`, pas en `O(entités²)`.

**Les forces s'accumulent dans un tableau séparé, puis s'appliquent toutes en même temps.**
Si on les appliquait au fil de l'itération, le résultat dépendrait de l'ordre de parcours —
et deux simulations dont les tableaux sont compactés différemment divergeraient. C'est le
même raisonnement que le tri canonique du §3.1, appliqué à la boucle physique.

**Ce que la séparation résout, au-delà du réseau.** La vérification visuelle de l'étape 2 a
montré que la horde forme des **files** : les entités s'alignent sur les mêmes couloirs,
conséquence directe des huit directions discrètes par cellule de flowfield. Or le §4.1 veut
« des formations denses de chair à canon », pas des colonnes. La séparation est ce qui fait
respirer la masse.

---

## 5. Le combat

### 5.1 Les armes sont des données

Définitions typées dans `shared/`, exécutées par un système unique — même principe que les
vagues de l'étape 2, et même raison : le §9.1 rappelle que Riot a déplacé son spawn du
script vers de la donnée pour tenir la charge.

| Champ | Rôle |
| --- | --- |
| `cooldownTicks` | cadence de tir |
| `damage` | dégâts par projectile |
| `projectileSpeed` | vitesse, en pixels monde par seconde |
| `projectileLifeTicks` | portée, exprimée en durée de vie |
| `projectileCount` | nombre de projectiles par salve |
| `spreadRadians` | dispersion de la salve |

L'étape en câble **trois** : l'arme neutre de base du §6.1 — faible, sans élément, hors
slots — plus deux autres, assez différentes pour prouver que la forme tient. Le pool devra
en compter quarante (§6.2) ; c'est du contenu, pas de l'architecture.

### 5.2 Le tir est dérivé, pas répliqué

> **Écart assumé vis-à-vis du §3.3**, qui prévoit un événement de tir sur le fil (arme,
> direction, tick).

Un tir est **entièrement déterminé** par des données que les deux côtés possèdent déjà :

- la cadence de l'arme et le tick — donc les instants de tir sont calculables ;
- la position du tireur au tick `T − K`, présente dans l'historique du §5 de la spec de
  l'étape 2 ;
- la cible, choisie sur l'état de la horde au tick `T − K` (§5.3).

Serveur et clients calculent donc les mêmes salves, aux mêmes ticks, sur les mêmes cibles.
**Zéro octet, et aucun événement à perdre.**

C'est la même logique que la horde, et l'étape 2 a montré qu'elle donne 0,000 px de dérive
dès lors que les entrées sont identiques. Le seul cas où un tir doit être annoncé est le
**changement d'arsenal** — rare, et déjà un événement serveur à l'étape 4.

**Repli, si la dérivation s'avère fragile :** revenir à l'événement de tir explicite du
§3.3. Le protocole doit rester capable de l'accueillir sans refonte.

### 5.3 L'auto-visée lit le passé

La cible est **l'ennemi le plus proche dans l'état de la horde au tick `T − K`**, et non
dans l'état courant.

La raison tient en une phrase : entre le moment où le serveur tue un ennemi et celui où le
client l'apprend, le client voit une horde qui n'est plus la bonne. Viser dans cet état-là
ferait désigner des cibles différentes d'un poste à l'autre — exactement ce que le §3.2
signale comme résolu chez *The Spell Brigade* par un « ciblage déterministe ».

L'état `T − K` est celui que les deux côtés savent reproduire, et c'est déjà la machinerie
qui alimente le flowfield. On la réutilise plutôt que d'en inventer une seconde.

**À égalité de distance, l'identifiant le plus petit gagne.** Une comparaison flottante
stricte laisserait le départage à l'ordre de parcours des tableaux.

**Ce que ça coûte :** on vise une position vieille d'une centaine de millisecondes. Sur un
ennemi à 95 px/s, c'est ~10 px — un sixième de sprite. Invisible, et le §3.4 fait de toute
façon pencher l'arbitrage en faveur du joueur.

### 5.4 Les dégâts sont arbitrés par le serveur

Le client montre l'impact **immédiatement** — c'est ce qui donne le punch — mais un ennemi
ne meurt que lorsque le message du §3.1 arrive.

L'asymétrie est délibérée, et c'est celle du §3.4 : un ennemi qui « aurait dû » mourir et
survit une fraction de seconde ne se remarque pas ; un ennemi qui disparaît alors qu'on ne
l'a pas touché, si.

---

## 6. La boucle de run

### 6.1 L'expérience se dérive des morts

Un ennemi mort laisse un orbe **à sa position** — et cette position, les deux côtés la
connaissent déjà : la mort porte l'identifiant, et la horde est répliquée. **Zéro octet
supplémentaire**, comme pour les tirs.

**Le ramassage, lui, ne se dérive pas.** C'est un événement irréversible qui dépend d'une
position — exactement comme le contact du §3.4 — et le §3.1 rappelle que le serveur doit
posséder tout ce qui a de la valeur. Il l'annonce donc, sur le même modèle que les morts :

| Champ | Type |
| --- | --- |
| `tick` | `u32` |
| `count` | `u16` |
| `orbId` | `u32` × count, triés |

**L'identifiant d'un orbe est celui de l'ennemi qui l'a lâché.** Rien à allouer, rien à
synchroniser : si le client sait qu'une entité est morte, il sait où est son orbe et
comment il s'appelle. Le tri croissant sert la même chose qu'au §3.1 — un ordre
d'application canonique.

Un orbe non ramassé disparaît après une durée fixe, identique des deux côtés, donc dérivable
sans message.

**L'expérience est globale** (§2). La courbe est multipliée par N (§5) — sans effet visible
en solo, mais la formule s'écrit dès maintenant pour que l'étape 4 n'ait pas à la rouvrir.

### 6.2 Le gel

À la montée de niveau, **le monde et le chronomètre se figent** (§7.4). Le serveur cesse
d'avancer le salon et diffuse un message portant le niveau atteint ; les clients figent leur
horde au même tick.

**La reprise est progressive sur une seconde**, comme chez *Swarm* : sans elle, on se fait
toucher à la reprise sans avoir eu le temps de réagir.

L'écran se contente d'annoncer le niveau et de monter une arme automatiquement.
**L'étalage de l'étape 4 se branchera exactement là**, sans toucher au mécanisme de gel —
c'est pour ça qu'il est construit maintenant, avec le reste du contrat de réplication,
plutôt que greffé après coup dans une boucle déjà figée par les tests.

### 6.3 La mort du joueur, et la fin

Le joueur a des points de vie. Le contact avec un ennemi lui en retire, **arbitré par le
serveur, avec une hitbox généreuse et un arbitrage penchant en faveur du joueur** (§3.4).
C'est le seul endroit où la position d'un monstre a une conséquence irréversible, et c'est
pour cette raison que le serveur tranche.

À zéro, la run s'arrête sur un **bilan** : temps survécu, niveau atteint, ennemis tués.

---

## 7. Protocole

Quatre messages nouveaux, tous additifs.

| Message | Contenu | Cadence |
| --- | --- | --- |
| `DEATHS` | §3.1 | à chaque tick où quelqu'un meurt |
| `PICKUPS` | §6.1 | à chaque tick où un orbe est ramassé |
| `LEVEL_UP` | niveau atteint, tick du gel | à chaque montée |
| `RUN_OVER` | temps survécu, niveau, ennemis tués | une fois |

Le `SNAPSHOT` gagne les points de vie et l'expérience — quelques octets par joueur, sans
rapport avec le nombre d'entités.

> Le test d'indépendance réseau de l'étape 2 dérive son plafond de
> `SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES`. Ces constantes changeant, **il suivra
> tout seul** — c'est précisément pourquoi il avait été écrit ainsi plutôt qu'avec des
> nombres en dur.

**Aucun message pour les tirs, les projectiles ou l'apparition des orbes** : tous dérivés
(§5.2, §6.1). Seuls transitent les événements irréversibles qui dépendent d'une position —
morts, ramassages — plus les deux événements de run.

---

## 8. Vérification

### 8.1 Le test qui porte l'étape

Extension directe de `shared/horde.replication.test.ts`, qui compte déjà sept scénarios.
On en ajoute, avec **morts, séparation et rejeu** :

1. cinq simulations, mille entités, morts injectées à cadence réaliste ;
2. les clients reçoivent les morts avec **1 à 3 ticks de retard**, comme le reste ;
3. assertions : **ensemble d'identités strictement égal**, et dérive de position bornée.

**Un scénario doit mesurer le cas SANS rejeu**, pour que le chiffre existe — exactement
comme les deux lignes à 693,899 px et 769,738 px de l'étape 2, qui sont les plus précieuses
du tableau parce qu'elles montrent ce que le mécanisme ferait sans ses corrections.

### 8.2 La vérification par mutation est obligatoire

Un test qui rend zéro peut aussi bien ne rien comparer. L'étape 2 a produit **trois tests
qui ne vérifiaient rien** avant qu'on ne s'en aperçoive. Chaque propriété nouvelle sera donc
vérifiée en **cassant volontairement le code** et en confirmant que le test rougit :

- ordre d'application des morts non canonique ;
- forces de séparation appliquées au fil de l'itération plutôt qu'en bloc ;
- rejeu désactivé ;
- auto-visée lisant l'état courant au lieu de `T − K`.

### 8.3 Ce qui reste manuel

Ouvrir le jeu, jouer une run entière, et juger : est-ce que ça *fait* un bullet heaven ? La
masse respire-t-elle, ou forme-t-elle encore des files ? Le tir a-t-il du punch ? Le gel
au niveau est-il lisible ? C'est du jugement, pas une assertion.

---

## 9. Risques

| Risque | Parade |
| --- | --- |
| **Le rejeu coûte trop cher** — le plus probable | Spike en tête de plan (§3.3), avec trois issues chiffrées |
| La séparation casse le déterminisme par l'ordre d'itération | Accumulation puis application en bloc (§4), vérifiée par mutation |
| La dérivation des tirs s'avère fragile | Repli documenté vers l'événement de tir du §3.3 (§5.2) |
| Une mort trop vieille pour l'historique | Appliquée au présent **et signalée**, jamais en silence (§3.2) |
| Le gel désynchronise les ticks | Le serveur date le gel ; les clients figent au tick indiqué (§6.2) |

---

## 10. Questions laissées ouvertes

- **La valeur de `K`** pour l'auto-visée : la même que celle du flowfield (3 ticks), ou une
  autre ? À trancher sur mesure, comme le reste.
- **La profondeur d'historique du rejeu** dépend du chiffre du spike.
- **Le rayon et la force de séparation** sont un réglage de sensation, à faire en jouant.
- **`MAP_SIZE` reste à 6 000.** Le §15.2 propose 10 000 ; l'agrandir avant que la densité de
  vagues ne soit réglée n'apporterait rien.
- **Le §13 n'est toujours pas couvert par un test à quatre vrais clients** sur un vrai
  réseau — réserve héritée de l'étape 2, et cette étape ne la lève pas.
