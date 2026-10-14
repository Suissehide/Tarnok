# Étape 8 — les classes : résultats

**Spec :** [`../specs/2026-10-13-etape-8-classes.md`](../specs/2026-10-13-etape-8-classes.md)
**Plan :** [`2026-10-13-etape-8-classes.md`](2026-10-13-etape-8-classes.md)

Chaque joueur choisit au salon une classe, puis son arme ; la classe lui donne un verbe — une
capacité active, déclenchée à la touche Espace — que le salon arbitre, annonce une fois, et que les
deux côtés dérivent identiquement. Quatre verbes agissent, et la horde converge toujours à
**0,000 px** malgré les leurres.

⚠️ **Ce document est ouvert.** Le §8 attend la run de l'auteur, et le §2.3 une décision de
conception : **le trait d'Amorce ne fait rien** tel qu'il est écrit.

## 1. Le livrable, et ce qui le distingue

`back/src/classes.integration.test.ts` — **6 tests, 5/5 lancers verts**, sur vraies sockets. Le
joueur choisit sa classe au salon, la partie démarre, il demande son verbe, et l'effet s'observe **à
travers le décodage**, jamais depuis l'état interne du salon :

| Verbe | Ce qui le prouve sur le fil |
| --- | --- |
| Amorce | l'annonce, puis une `ZONE` de l'élément de l'arme, à réaction nulle |
| Rempart | les PV de l'allié dans le `SNAPSHOT` : il perd `CONTACT_DAMAGE x (1 − REMPART_ARMOR)`, pas `CONTACT_DAMAGE` |
| Appât | l'annonce au point du leurre, et la `ZONE` de l'élément de l'arme qu'il pose (le trait) |
| Relais | `targetId` de l'annonce, puis le lanceur sur la position de l'allié dans le snapshot suivant |

Et les deux tests qui décident : la taille **réelle** de chaque `SNAPSHOT` reçu, comparée à une
**valeur** (en-tête + 10 octets) et pas seulement à elle-même ; et une seule `ABILITY_USED` pour deux
demandes dans le même tick.

**La dérive du leurre** — le seul verbe qui touche la simulation de la horde — est éprouvée par le
scénario AP de `shared/horde.replication.test.ts`, sur le patron du scénario 11c (charge du boss) :

| Scénario | Mesure |
| --- | --- |
| AP0 — les leurres déplacent réellement la horde | 474,385 px d'écart avec le témoin sans leurre |
| AP1 — sans rejeu, retards de 0 à 7 ticks | 318,816 px de dérive |
| AP2 — avec rejeu, retards de 0 à 7 ticks | **0,000 px** |

Mutation appliquée (le tick courant au lieu du tick des positions, d'un seul côté) : AP2 monte à
418,584 px et rougit.

## 2. Les décisions de conception, et leur raison

### 2.1 Le leurre remplace son lanceur, et n'agit pas avant sa naissance

Un leurre est une entrée de plus dans le tableau des positions qui nourrit le champ de flux — il
prend la **place** de son lanceur, retrouvé par son **identifiant** (les rangs bougent quand un
joueur part). Zéro champ de plus : le banc de l'étape 1 a mesuré le budget à quatre.

**Écart au plan, et il décide de la réplication** : `substituteDecoys` ne substitue pas à des
positions **plus anciennes** que le leurre. Le plan ne bornait que l'expiration. Sans la borne
basse, le serveur — qui connaît le leurre dès sa pose — l'appliquerait à des positions retardées de
trois ticks, alors que le client, qui l'apprend plus tard, ne le ferait pas. Quand l'annonce arrive
après que le client a déjà nourri son champ, il restaure l'anneau à la naissance du leurre et
rejoue — exactement `#applyBossCharge`.

### 2.2 L'abus évité : Rempart et Armure par le MAXIMUM

La boutique vend `Armure` sur cinq paliers. Une somme avec la protection du Rempart aurait donné une
quasi-immunité qui se paie en or, donc qui se verrait mal. `armorOf` prend le **maximum**, la même
règle que `ZoneField` applique déjà entre deux zones. Et `player.armor` est recalculé avant **les
deux** sources de dégâts — la charge du boss et le contact —, pas seulement le contact.

### 2.3 ⚠️ Le trait d'Amorce est un mécanisme mort — à redessiner

Le trait a été redessiné une fois **avant** l'implémentation : la première version (« votre zone
survit à la réaction ») ne faisait rien, aucune réaction ne consommant la zone qui l'a déclenchée.

**La seconde version ne fait rien non plus**, et la tâche 9 l'a trouvé en préparant sa mutation
n°9. Le plan le prévoyait (tâche 4, étape 4) : *« si les quinze en laissent déjà un, arrête-toi et
dis-le »*. C'est le cas : `applyReactions` (`back/src/combat.ts`) appelle `postZone` pour **chaque**
déclencheur, sans condition. Les quinze réactions laissent déjà une zone au sol ; les trois
« à résidu » du §6.4 (Surchauffe, Gel profond, Aveuglement) ne s'en distinguent que par une zone
**plus longue** (135 ticks au lieu de la durée générique).

Le trait n'a donc **jamais été implémenté**, et c'est voulu : l'implémenter tel qu'écrit aurait
ajouté un cinquième mécanisme mort au registre de l'étape 5c. **Décision de conception attendue de
l'auteur.** Pistes qui changent réellement une règle : les zones nées d'une réaction dans une zone
d'Amorce durent comme les trois résidus longs ; ou elles portent les deux éléments de la réaction
au lieu du seul déclencheur. L'écran du salon annonce toujours ce trait : à corriger avec la
décision.

### 2.4 La prémisse levée

Le §6.7 de l'orientation interdisait l'arme signature pour garder l'élément comme enjeu du premier
étalage. La salle d'attente fait désormais choisir l'arme — donc l'élément — avant la partie : **la
raison est caduque, la conclusion tient**. La classe garde un métier propre, un verbe et un trait,
sans recouvrement avec l'arme. **Le §6.7 et le §7.1 de l'orientation doivent être amendés** : la
négociation lourde des éléments s'est déplacée du premier étalage vers l'écran d'attente.

### 2.5 Une seule arme au départ

Décision de l'auteur, prise pendant l'étape : l'arme choisie au salon **remplace** la dague au lieu
de s'y ajouter (`PlayerState.keepsBase`, et `firesBase` côté miroir). Un joueur sans choix, ou
arrivé en cours de partie, garde la dague.

## 3. Le coût sur le fil

| Poste | Coût |
| --- | --- |
| La classe de chacun | **1 octet par joueur, une fois**, sur `PICK` et `LOBBY`, avant la partie |
| L'annonce d'un verbe | une trame `ABILITY_USED` de 12 octets **par usage**, jamais périodique |
| La recharge | **zéro** — constante partagée, le client la dérive de l'annonce |
| L'instantané | **zéro octet de plus.** `SNAPSHOT_PLAYER_BYTES` reste à **10**, mesuré sur le fil |

Contraste avec l'étape 7b, qui avait payé un octet **par joueur et par tick** par décision explicite.
Rien dans un verbe n'a besoin d'être répété à 30 Hz.

## 4. La campagne de mutation

Commandes lancées sur le fichier entier, jamais avec `-t`, après le commit `ff01ade`.

| # | Mutation | Commande | Résultat |
| --- | --- | --- | --- |
| 1 | `useAbility` ignore la recharge | `back: room.test.ts verbes.test.ts` | tuée — 3 rouges |
| 2 | `useAbility` accepte un mort | `back: room.test.ts` | tuée — 1 rouge |
| 3 | `PICK` enregistre un `classId` hors catalogue | `back: lobby.integration.test.ts` | tuée — 1 rouge |
| 4 | `substituteDecoys` pousse le leurre à la fin | `shared: decoys.test.ts horde.replication.test.ts` | tuée — 7 rouges |
| 5 | `substituteDecoys` ignore l'expiration | idem | tuée — 1 rouge |
| 6 | le rejeu client ignore les leurres | `front: net/verbes.test.ts net/client.test.ts` | **survivante → tuée** — 1 rouge après ajout |
| 7 | `armorOf` rend la somme | `back: verbes.test.ts` | tuée — 1 rouge |
| 8 | le contact lit l'armure du compte | `back: verbes.test.ts combat.test.ts` | tuée — 1 rouge |
| 9 | le trait d'Amorce | — | **non jouée** : le trait n'existe pas (§2.3) |
| 10 | la recharge posée avant la validation de la cible | `back: verbes.test.ts room.test.ts` | tuée — 1 rouge |

**Le trou de la n°6.** Le test de câblage existant plantait le leurre **avant** que le champ ne
l'ait manqué : aucun rejeu, donc `#replayTick` jamais éprouvé. Ajouté : *un leurre annoncé en
retard est substitué PENDANT le rejeu* — l'annonce arrive après des champs déjà nourris, au tick
d'un pas qui n'est pas un pas de champ, si bien que seuls les reciblages du rejeu sont observés.
Une garde du décor vérifie qu'au moins un champ rejoué lit des positions où le leurre vit.

## 5. Les chiffres du portique, mesurés par le coordinateur

| Commande | Résultat |
| --- | --- |
| `npm run lint` (Biome) | vert |
| `npm run typecheck` (front et back) | vert |
| `npm test -w front` | **28 fichiers, 567 tests** verts |
| `npm test -w back` (dont `shared/`) | **53 fichiers, 1 230 tests** verts |

Lancé seul, rien d'autre en vol, après la campagne et l'ajout de la n°6.

**Le contrat de réplication tient toujours à 0,000 px**, sur chaque scénario avec rejeu — dont le
nouveau AP2.

## 6. Les erreurs du plan, et qui les a trouvées

| Tâche | Défaut | Trouvé par |
| --- | --- | --- |
| 4 | Le trait `residuPartout` est mort : les quinze réactions laissent déjà une zone (§2.3). La tâche 4 l'avait laissé non implémenté, sans le dire. | La préparation de la mutation n°9, tâche 9 |
| 4 | L'étape 6 (miroir client de la zone d'Amorce) est inutile : la zone est annoncée par `ZONE` comme toute zone, et un second `spawn` côté client l'aurait doublée. | L'implémenteur des tâches 6-7, en cherchant le miroir |
| 6 | `substituteDecoys` sans borne basse : le serveur appliquerait le leurre trois ticks avant le client (§2.1). | L'implémenteur, en écrivant le scénario AP |
| 6 | « Les deux sites » d'entrée du champ côté client sont **trois** : l'amorce du rejeu (`#primeFieldForReplay`) nourrit aussi les champs. Tous passent désormais par `#feedFields`. | L'implémenteur, en lisant `client.ts` |
| 6 | Le plan ne disait pas comment le client apprend un leurre en retard ; sans rejeu, AP1 mesure 318 px de dérive. | Le scénario AP1 |
| 9 | Le test de câblage du leurre côté client n'éprouvait pas le rejeu : la mutation n°6 survivait. | La campagne de mutation |
| 3 | Le plan prévoyait d'envoyer `ABILITY` côté client à la tâche 3, et le client n'en avait rien : ni envoi, ni réception d'`ABILITY_USED`, ni touche. Fait avec la touche du verbe. | Le coordinateur, en reprenant l'étape |

## 7. Écarts assumés

- **Les tests des verbes vivent dans `back/src/verbes.test.ts` et `front/src/net/verbes.test.ts`**,
  pas dans `room.test.ts` (plus de 5 000 lignes) ni `prediction.test.ts`.
- **`Room` gagne des écritures de test** — `debugPlace`, `debugKill`, `debugRevive` — sur le modèle
  de `debugSetGold`. Aucun chemin de production ne les appelle.
- **Le trait d'Amorce n'est pas implémenté** (§2.3).
- **Le Relais ne sait pas « attirer l'allié à soi »** : la spec donnait les deux sens, le plan n'en
  a retenu qu'un, la téléportation du lanceur.
- **Les recharges, rayons et durées sont des réglages de départ**, nommés dans
  `shared/abilities.ts`, à confronter au playtest.

## 8. Vérification manuelle

⚠️ **Section ouverte — attend la run de l'auteur.**

1. **Le choix au salon** : la classe d'abord, l'arme ensuite — se lit-il comme deux étapes
   naturelles ? Les doublons de classe se négocient-ils d'eux-mêmes ?
2. **Le Rempart** : le dôme bleu se voit-il en pleine horde, et la protection se sent-elle ?
3. **L'Appât** : la horde se détourne-t-elle de façon lisible vers la cible orange, et revient-elle
   sans à-coup quand le leurre expire ?
4. **Le Relais** (deux onglets) : la téléportation est-elle nette, sans glissement de la
   prédiction, et l'intangibilité de l'allié se remarque-t-elle ?
5. **La case du verbe** : la recharge en secondes se lit-elle d'un coup d'œil ?
6. **Les recharges** (6 s, 12 s, 15 s, 10 s) : trop courtes, trop longues ?

## 9. Questions laissées ouvertes

- **Le trait d'Amorce** (§2.3).
- **Faut-il montrer la classe des autres en partie ?** Rien n'en a besoin, et ça coûterait des
  octets. Laissé fermé, comme le disait la spec.
- **Quatre verbes suffisent-ils à faire une négociation ?** À confirmer au playtest.

## 10. Dette reportée

- **Six parties à jouer sont désormais dues** : 5b §4, 6a §3, 5c §12, 7a §10, 7b §8, et celle-ci
  (§8). Aucune n'a encore reçu la run de l'auteur.
- **L'atlas de monstres dérivé n'est toujours pas sur MinIO** — la production perdrait toute la
  horde. Dette héritée.
- **Le chemin de la salle pleine n'est testé nulle part.** Dette héritée de 7b.
- **Les deux défauts de la salle d'attente relevés par la spec (§10)** : le premier (aucune
  vérification de déblocage) **n'a plus d'objet**, toutes les armes étant désormais disponibles
  d'emblée ; le second reste ouvert — `startingWeapons` n'exclut pas les armes déjà prises par un
  autre joueur, donc l'exclusivité du §6.2 n'est pas tenue au salon.
- **`lateDecoys`** compte les leurres annoncés trop tard pour l'anneau, mais rien ne l'affiche
  encore dans le HUD de diagnostic.
