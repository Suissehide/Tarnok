# Étape 10 — la rareté, et des passifs qui s'empilent

## 0. Statut et place dans la suite

Deuxième des quatre étapes décidées le 15 octobre 2026 (roue de ping, **rareté et passifs**, élites
à coffre, événements bonus). Décisions prises avec Léo avant d'écrire :

- *« ce qui est marrant c'est l'accumulation qui donne un côté op »* — les nouveaux passifs
  s'empilent **sans plafond** et se multiplient entre eux, jamais de contrepartie ;
- la rareté **multiplie** une carte (commune ×1, rare ×2, légendaire ×3), plus quelques passifs
  **exclusivement légendaires** ; **aucune arme rare** — les armes portent les éléments, et
  l'équilibre des quinze réactions repose sur leur répartition (`elements-5c`).

Elle s'appuie sur le système de cartes d'amélioration d'arme arrivé le même jour (`9cbb06a`,
`a82a499`) : une carte d'arme possédée améliore un aspect (`UPGRADE`) de l'arme.

⚠️ **`main` reçoit des modifications en direct** au moment d'écrire (dégâts chiffrés, critiques,
bonus propres aux armes). L'exécution se fera dans un worktree, comme l'étape 9.

## 1. Le livrable en une phrase

**Une carte de l'étalage peut sortir rare ou légendaire, et vaut alors deux ou trois cartes ; quatre
passifs empilables et trois passifs légendaires font monter le build vers le démesuré.**

Vérifiable ainsi : sur vraies sockets, une carte rare prise donne exactement deux exemplaires dans
l'inventaire arbitré par le salon, et le client en tient le même miroir ; aucun octet de plus par
tick.

## 2. La rareté

### 2.1 Le modèle

`shared/rarity.ts` :

| Rareté | Index | Multiplicateur | Probabilité par carte |
| --- | --- | --- | --- |
| commune | 0 | ×1 | 82 % |
| rare | 1 | ×2 | 15 % |
| légendaire | 2 | ×3 | 3 % |

Les probabilités sont des **constantes nommées** (`RARITY_WEIGHTS`), réglables au playtest.

`Card` gagne `rarity?: number` (absent : commune).

### 2.2 L'effet : une carte rare vaut deux cartes, et rien de plus

`applyCardToLoadout` applique la carte **autant de fois que son multiplicateur**. Aucune règle
d'empilement nouvelle :

- un **passif** : `addPassive` ×n ;
- une **arme** : `addWeapon(id, upgrade)` ×n — la première application est l'acquisition si le
  joueur ne l'avait pas, les suivantes sont des améliorations du **même aspect** (`card.upgrade`).
  Une acquisition ne prend toujours qu'**un** emplacement.

`Room#grantCard` soigne la vitalité « hors inventaire » : le soin suit le multiplicateur, puisqu'il
lit l'écart de PV max avant/après.

`canTake` reste la seule règle d'éligibilité, testée sur la première application.

### 2.3 Le tirage

`drawSpread` tire la rareté **de chaque carte** après l'avoir choisie, avec le même `rng`. Les
passifs exclusivement légendaires (§4) n'entrent dans le tirage **que** pour une carte qui sort
légendaire : on tire d'abord la rareté de l'emplacement, puis la carte parmi le pool qui lui est
permis.

Le plancher de rareté des coffres (≥ rare) et des événements (≥ légendaire) n'est **pas** dans
cette étape : il arrive aux étapes 11 et 12, avec son premier appelant.

### 2.4 Le fil

`WireCard` gagne la rareté : `DRAFT_CARD_BYTES` passe de **3 à 4**. Un octet par carte, dans un
message envoyé une fois par montée de niveau — jamais par tick. Les tests qui assènent la taille de
`DRAFT_OPEN` (6 + 5 × 3 = 21 à deux joueurs) passent à 6 + 5 × 4 = **26**.

### 2.5 L'écran

L'étalage donne à chaque carte une bordure par rareté — **gris**, **bleu**, **or** — et un léger
reflet animé à la légendaire. L'étiquette dit le multiplicateur (« Rare ×2 », « Légendaire ×3 »)
en plus de ce que la carte apporte.

## 3. Quatre passifs empilables, sans plafond

| Passif | Par carte | Où ça agit |
| --- | --- | --- |
| **Précision** | +4 % de chance de critique (plafond 100 %) | tirage du critique à l'apparition du projectile |
| **Férocité** | +30 % de dégâts critiques | multiplicateur emporté par le projectile |
| **Volée** | +1 cran de **salve** sur chacune de tes armes de tir | `upgradedWeapon` |
| **Ampleur** | +1 cran de **zone** sur chacune de tes armes | `upgradedWeapon` |

### 3.1 Volée et Ampleur : des améliorations globales

Plutôt qu'un nouveau calcul, ces deux passifs **ajoutent des crans** aux améliorations que la
carte d'arme sait déjà faire (`UPGRADE.SALVO`, `UPGRADE.ZONE`). `upgradedWeapon` reçoit déjà une
fonction `upgrades(aspect)` ; le serveur (`Room#fireOne`) et le client (son miroir de tir) lui
passent désormais *« crans de l'arme + crans des passifs »*. Une seule fonction partagée calcule
cette somme, appelée des deux côtés — c'est elle qui garantit que la salve dérivée par le client
est celle que le serveur tire.

Volée ne touche que les armes de genre `'tir'` ; Ampleur touche toutes les armes.

Conséquence voulue : une Volée légendaire donne **+3 crans de salve à toutes tes armes de tir
d'un coup**, et se multiplie avec les cartes « salve » de chaque arme.

### 3.2 Précision et Férocité : ce que le projectile emporte

Le critique est tiré à l'apparition du projectile (`Projectiles.spawn`, `hashRoll < CRIT_CHANCE`),
**des deux côtés**. La chance devient celle du **tireur** : `CRIT_CHANCE + 0,04 × Précision`, bornée
à 1. Le client la connaît : il tient le miroir des inventaires de tous les joueurs.

Le multiplicateur critique, lu aujourd'hui en constante (`CRIT_MULTIPLIER`) à trois endroits
(`back/src/combat.ts` ×2, `front/src/net/client.ts` ×1), devient une valeur **par projectile**,
enregistrée à l'apparition : `CRIT_MULTIPLIER + 0,3 × Férocité`. Les trois lecteurs lisent le
projectile, plus la constante.

## 4. Trois passifs exclusivement légendaires

Ils changent une règle. Tous trois n'agissent **que côté serveur** — sur des PV, que le serveur
arbitre seul — donc sans risque de dérive et sans octet de plus.

| Passif | Effet par carte | Point d'accroche |
| --- | --- | --- |
| **Écho** | les dégâts instantanés des réactions **que tu déclenches** sont doublés (+100 % par carte) | `applyReactions` : `ReactionTrigger.by` désigne le déclencheur |
| **Moisson** | chaque ennemi qui meurt à moins de **300 px** de toi te rend **1 PV** | le drain des morts de `Room.step`, comme `regain` |
| **Colosse** | +1 % de dégâts par tranche de 10 PV max | la formule de dégâts, des deux côtés |

Un passif légendaire s'applique **×1** : son effet est déjà une règle, le triple serait du
décor. Il occupe un emplacement de passif (`PASSIVE_SLOTS = 3`) comme les autres.

⚠️ **Colosse touche la formule de dégâts, qui existe en deux copies** (`Room#fireOne` et le miroir
client, `client.ts` ~l.2991). L'étape la factorise en une fonction partagée avant d'y ajouter
Colosse : deux copies divergeraient au premier passif ajouté — le même argument que
`applyCardToLoadout`.

Moisson est coopérative par construction : les ennemis tués par un allié **près de toi** te
soignent aussi. Le serveur n'attribue pas les morts à un tueur ; la proximité évite d'avoir à le
faire.

## 5. Ce qui n'est PAS dans cette étape

- le plancher de rareté des coffres et des événements (étapes 11 et 12) ;
- le rééquilibrage des passifs existants ;
- des armes rares ;
- un plafond aux empilements, hors Précision (une chance au-delà de 100 % ne veut rien dire).

## 6. Les tests et le livrable

| Où | Quoi |
| --- | --- |
| `shared/rarity.test.ts` | poids et multiplicateurs ; sur un `rng` scripté, chaque rareté sort |
| `shared/cards.test.ts` | une carte rare de passif donne 2 exemplaires, une légendaire 3 ; une arme rare non possédée donne l'acquisition + 1 cran de son aspect ; un passif légendaire ne sort que sur un emplacement légendaire, et s'applique ×1 |
| `shared/protocol.test.ts` | `DRAFT_OPEN` à 4 octets par carte, rareté comprise |
| `shared/weapons.test.ts` (ou nouveau) | la somme « crans de l'arme + crans des passifs » : Volée sur une arme de tir, pas sur un halo ; Ampleur partout |
| `shared/projectiles.test.ts` | la chance de critique suit Précision (0 → constante ; assez de cartes → 100 %) ; le multiplicateur emporté suit Férocité |
| `back/src/combat.test.ts` | Écho double les dégâts d'une réaction déclenchée par son porteur, pas celle d'un autre |
| `back/src/room.test.ts` | Moisson : une mort à 299 px soigne, à 301 px non ; jamais au-delà du PV max |
| formule de dégâts partagée | Colosse : +1 % par tranche de 10 PV max ; serveur et client lisent la même fonction |
| `back/src/rarete.integration.test.ts` | **le livrable** : vraies sockets, un étalage à rareté forcée, la carte rare prise donne 2 exemplaires dans l'inventaire du salon et dans le miroir décodé par le client |
| `front/src/ui/draft.test.ts` | la bordure et l'étiquette selon la rareté |

**Vérification manuelle**, ouverte jusqu'au playtest :

- la rareté se lit-elle d'un coup d'œil dans l'étalage ?
- 82 / 15 / 3 : les légendaires sont-elles assez rares pour être un événement, assez fréquentes
  pour être vues ?
- Volée à +1 cran par carte commune : jusqu'où l'écran tient-il (lisibilité, et budget de
  projectiles) ?
- un build Précision + Férocité devient-il trop dominant ?

## 7. Risques

- **Le budget de projectiles.** Volée multiplie les projectiles sans plafond. La capacité est
  bornée (`PROJECTILE_CAPACITY`) : au-delà, des tirs sont perdus. Le banc existant le mesure ; si
  ça sature en playtest, le réglage est la valeur de Volée, pas un plafond caché.
- **Colosse et la boutique.** Les achats de vitalité permanente montent aussi le PV max : Colosse
  les convertit en dégâts. C'est voulu (accumulation), mais à surveiller.
- **Le tirage du draft auto** (expiration du délai) ne regarde pas la rareté. Un joueur absent
  prendra une carte au hasard du score existant, rare ou pas.
