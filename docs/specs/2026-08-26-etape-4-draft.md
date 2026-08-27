# Étape 4 — le draft : l'étalage commun à conflits

**Livrable du §13 :** quatre joueurs draftent, un conflit se résout.

*(Le §13 disait « et la priorité tourne ». La rotation est supprimée — voir §9.)*

**Spec d'orientation :** [`2026-08-19-coop-survivors-orientation.md`](2026-08-19-coop-survivors-orientation.md),
§6 (arsenal, slots, exclusivité) et §7 (le draft).

---

## 1. Périmètre

Le §7.1 pose l'enjeu : *« faire d'un écran de menu le moment le plus social de la partie »*.
Cette étape construit ce moment et le rend jouable — pas le catalogue de quarante armes du §6.2,
qui attend les éléments de l'étape 5 pour avoir un sens.

**Dans l'étape :**
- la machine à états du draft, arbitrée serveur ;
- le jeton, les intentions visibles, la résolution et sa révélation ;
- 8 à 10 armes et 4 à 6 passifs — assez pour que l'étalage ait de quoi tirer ;
- l'effet réel des cartes : une arme draftée tire, un passif empilé change un nombre.

**Hors de l'étape :**
- le catalogue complet et les six éléments (étape 5) ;
- l'écran soigné : fonctionnel et lisible ici, l'identité visuelle viendra quand les cartes
  auront un élément à porter ;
- les slots de passifs débloqués par événements et paliers de boss (§6.1) — trois slots fixes.

## 2. Ce que cette étape ne met pas en danger

L'étape 3 a établi un contrat de réplication à 0,000 px et l'a tenu à travers vingt-huit tâches.
**Le draft n'y touche pas**, et c'est une propriété de sa conception plutôt qu'une précaution :

La résolution est **aléatoire et calculée par le serveur seul**. Aucun client ne rejoue le
tirage, aucune graine n'est partagée, rien n'est dérivé. Le client affiche ce qu'on lui dit.
C'est le seul sous-système du jeu qui n'ait rien à prouver de ce côté.

Ce qui reste sous contrat : le **gel est daté par tick** (étape 3), et l'échéance du draft l'est
aussi. Sans ça les clients ne s'accorderaient pas sur la fermeture de la fenêtre.

> **Deux options écartées, pour qu'on ne les repropose pas.**
>
> **Dériver l'étalage** au lieu de le transmettre, par cohérence avec le §3.3. L'étalage fait
> sept cartes, une fois par niveau : le transmettre coûte quelques octets, le dériver crée une
> classe entière de désynchronisation. La dérivation vaut pour mille monstres à 30 Hz.
>
> **Faire tourner le draft sur l'horloge murale.** Le gel de l'étape 3 est daté par tick
> précisément pour que tous les clients figent au même instant. Une seconde base de temps
> rouvrirait ce problème.

## 3. Le modèle de cartes

> **Révisé après la vérification manuelle.** Ce §3 décrivait quatre natures de carte, des armes
> qui montaient de niveau, des évolutions, un `owner` et une exclusivité d'équipe. L'auteur a joué
> et a corrigé le modèle : *« il n'y a pas de niveau d'arme ; si quelqu'un a déjà pris lance-flammes,
> je peux lui voler la carte la prochaine fois ; c'est l'accumulation des cartes qui fait la
> puissance. »* Le §9 en garde la trace.

### 3.1 Deux natures, un seul objet

```ts
interface Card {
  nature: WEAPON | PASSIVE
  refId: number   // index dans WEAPONS ou PASSIVES — l'index EST l'identifiant
}
```

**Deux octets sur le fil.** Le catalogue suit le motif du dépôt (`archetypes.ts`, `weapons.ts`) :
une table, l'index est l'identifiant, aucune correspondance à synchroniser.

### 3.2 Tout est ouvert à tout le monde

**Il n'y a plus d'`owner`.** Il portait l'exclusivité des cartes réservées à leur porteur — montées
de niveau, évolutions — qui n'existent plus. Aucune carte n'appartient à personne avant d'être
prise.

Ce qu'un joueur peut prendre ne voyage donc plus sur la carte : ça se **dérive** de son inventaire
(`Loadout.canTake`). La même carte peut être prenable par l'un et pas par l'autre sans que
l'étalage ait à le savoir. Une seule règle : **on ne peut pas ouvrir un slot qu'on n'a plus, mais
empiler ce qu'on possède déjà est toujours possible.**

### 3.3 Tout s'empile, rien ne monte de niveau

| | Comportement | Borne |
| --- | --- | --- |
| **Arme** | **s'empile** — chaque exemplaire élargit la salve d'un projectile | aucune |
| **Passif** | **s'empile** — chaque carte prise augmente le bonus | aucune |

Modèle Risk of Rain, appliqué aux deux. Les armes et les passifs ne se distinguent plus par leur
comportement, seulement par ce qu'ils touchent.

**Pourquoi la salve et pas les dégâts ni la cadence** : c'est le levier le plus lisible à l'écran
dans un bullet heaven — on *voit* sa salve s'élargir. Une réduction de recharge se devine, et les
dégâts ne modulent aujourd'hui aucune issue, la piétaille n'ayant pas de réserve de points de vie
(décision de l'étape 3, voir `resolveCombat`).

### 3.4 Ce que l'étalage exclut

**L'arme neutre de base, et rien d'autre.** Elle vit hors des slots (§6.1), tout le monde l'a dès
le départ, et la proposer l'empilerait sur elle-même.

En particulier, **une arme déjà portée par un allié reste offerte** : chacun a son propre
exemplaire, et la carte de *cet étalage-ci* se dispute. C'est l'inverse exact de l'exclusivité
d'équipe que ce document décrivait auparavant.

**Le conflit n'est donc pas un accident, c'est le régime normal.** Rien ne s'exclut d'être déjà
possédé, donc toute carte reste convoitée par les N joueurs en permanence. C'est ce qui fait
exister la mécanique du §7.1.

## 4. La machine à états

Cinq états, tous datés par tick, tous arbitrés serveur.

| État | Ce qui se passe |
| --- | --- |
| **Ouverture** | le niveau tombe, `Room` gèle, le serveur tire N+3 cartes, diffuse `DRAFT_OPEN` avec le tick d'échéance |
| **Négociation** | chacun pose son jeton ; le serveur rediffuse les intentions en continu |
| **Fermeture** | à l'échéance ou quand tous ont posé ; le serveur résout |
| **Repioche** | les perdants reposent sur ce qui reste, **5 s de plus** (§7.2 point 4) |
| **Reprise** | le gel se relâche sur la rampe `LEVEL_RESUME_TICKS`, déjà en place |

### 4.1 Le jeton

**On pose un jeton sur une carte. L'intention *est* la sélection.** Pas de survol puis validation
séparés : un seul geste, un seul message, et c'est ce jeton que voient les autres.

Le jeton se déplace tant que la fenêtre est ouverte.

C'est ce qui crée la négociation — le §7.2 point 3 est catégorique : *« sans cette visibilité, la
mécanique n'existe pas »*.

### 4.2 La résolution, et sa révélation

Plusieurs jetons sur une carte : **un gagnant tiré au hasard**.

**C'est un seul moment, à l'échéance.** *« Si à la fin du timer on s'est pas départagé, ça brûle la
carte si je l'ai pas eu et ça en illumine une autre ; les restantes fade simplement. »*

| Pour qui | Ce qu'il voit |
| --- | --- |
| Le gagnant | sa carte **s'illumine** |
| Le perdant | sa carte **se consume**, puis une autre **s'illumine** — celle qu'il obtient à la place |
| Tout le monde | les cartes restantes **s'estompent** |

La révélation est **asymétrique et simultanée** : la même carte s'illumine chez l'un et brûle chez
l'autre, au même instant, sur le même objet.

**Le perdant ne rechoisit pas.** Une fenêtre de repioche de cinq secondes a existé dans cette spec ;
elle a été retirée. Le serveur lui attribue d'office la première carte libre que son inventaire peut
accueillir, et cette carte s'illumine dans la foulée.

> Ce traitement fait le travail que la rotation de priorité devait faire dans la spec
> d'orientation : rendre la perte **lisible** plutôt que subie. On voit ce qu'on perd, on voit ce
> qu'on obtient à la place, dans la continuité du même geste.

### 4.3 La fenêtre

| | Durée |
| --- | --- |
| À plusieurs | **20 s plafonnées** (§7.4) |
| **En solo** | **se referme au clic** — pas de plafond |

Le solo justifie son exception. On monte de niveau toutes les ~14 s en début de run : vingt
secondes de gel à chaque fois rendraient une run solo majoritairement figée. Le §7.4 s'inquiète
déjà de ce coût à quatre joueurs.

`LEVEL_FREEZE_TICKS` valait 60 ticks (2 s) à l'étape 3, en attendant cette étape. Il est remplacé
par **une** constante :

| Constante | Valeur | Ce qui la contraint |
| --- | --- | --- |
| `DRAFT_WINDOW_TICKS` | 600 (20 s) | plafond du §7.4, **à plusieurs seulement** |

Il y en avait deux : `DRAFT_REPICK_TICKS` (150, 5 s) est tombée avec la repioche.

En solo la fenêtre ne s'applique pas : le gel dure jusqu'au clic. `LEVEL_RESUME_TICKS` (30, la
rampe de reprise) est inchangé — il vient de l'étape 3 et fonctionne.

### 4.4 Une borne de robustesse

**Un joueur absent ne bloque jamais.** À l'échéance, le serveur attribue d'office. Ce n'est pas
un cas rare : un onglet en arrière-plan ne rend rien mais reste connecté, et ça arrivera
constamment pendant les tests à quatre onglets.

La règle, **déterministe et sans réglage** — c'est ce que le §7.2 point 6 appelle « un score
simple » : **la première carte libre de l'étalage que son inventaire peut accueillir, dans l'ordre
du tirage.**

Elle comptait deux clauses ; la première — « la carte dont il est le seul éligible » — servait les
cartes réservées, qui n'existent plus.

Un joueur absent ne peut jamais priver un joueur présent d'une carte qu'il vise : l'attribution
d'office s'efface devant tout jeton posé, parce qu'elle est résolue **après** les conflits.

**Il n'y a plus de seconde borne.** « La repioche ne peut pas boucler » gardait un tour de
négociation supplémentaire ; sans repioche, il n'y a plus de boucle possible.

## 5. Le protocole

Quatre messages, tous datés par tick.

| Message | Sens | Contenu |
| --- | --- | --- |
| `DRAFT_OPEN` | S → C | les cartes, le tick d'échéance |
| `DRAFT_TOKEN` | C → S | la carte sur laquelle je pose |
| `DRAFT_INTENTS` | S → C | qui a posé sur quoi |
| `DRAFT_RESULT` | S → C | attributions, conflits perdus, **et le tick où le gel prend fin** |

`DRAFT_RESULT` est émis **exactement une fois par draft** : la résolution est un seul moment. Il a
porté un octet `phase` qui distinguait « terminé » de « une repioche s'ouvre » ; la repioche n'existe
plus, le message n'a plus qu'un sens possible.

`DRAFT_INTENTS` est le seul à cadence soutenue : un octet par joueur, pendant la fenêtre, une
fois par niveau. **Sans rapport avec le nombre d'entités** — le test d'indépendance réseau de
l'étape 2 reste valide et doit le rester.

> ⚠️ **`DRAFT_RESULT` doit porter la fin du gel, et ce n'était pas dans la première version de
> cette spec.** À l'étape 3 le client la calculait lui-même — `msg.tick + LEVEL_FREEZE_TICKS - 1`
> — parce que le gel durait une constante.
>
> Ce n'est plus vrai : la fenêtre dure jusqu'à ce que tout le monde ait posé son jeton, et en solo
> elle se ferme au clic. **Le client ne peut plus la déduire.** Sans ce champ, chaque client
> devinerait une fin différente — précisément la divergence que le gel daté par tick existait pour
> empêcher. `LEVEL_FREEZE_TICKS` disparaît donc, et ses six usages actuels avec elle.

## 6. Les slots

Repris du §6.1 sans modification :

| Catégorie | Nombre |
| --- | --- |
| Arme neutre de base | 1, **hors slots** |
| Armes | 5, toutes draftées |
| Passifs | 3 (les slots extensibles à 6 sont hors étape) |

## 7. Ce qui rend l'étape jouable plutôt que décorative

C'est le point qui sépare cette étape d'un menu qui s'ouvre et se ferme.

**Une arme draftée tire réellement.** `Room#fireWeapons` est aujourd'hui câblé en dur sur
`weaponOf(0)` — l'arme neutre. Il doit parcourir les slots du joueur.

**Un passif empilé change un nombre mesurable.** Deux fois la même carte doit doubler le bonus.

**Une arme empilée élargit sa salve.** Deux exemplaires doivent envoyer un projectile de plus
qu'un seul — c'est le seul endroit où « l'accumulation fait la puissance » devient observable.

Sans ces trois-là, on distribuerait des cartes sans effet, et personne ne s'en apercevrait avant
l'étape 5.

## 8. Vérification

**La machine à états, sans serveur.** `back/src/draft.ts` se teste comme `combat.ts` : ouverture,
jeton posé puis déplacé, conflit, résolution, attribution d'office, échéance, joueur absent.

**Quatre clients, en headless.** Le livrable demande quatre joueurs, et quatre onglets ne
rendront pas — `requestAnimationFrame` est suspendu en arrière-plan, mesuré à l'étape 2 (zéro
image en quinze secondes). C'est un test d'intégration à quatre clients qui porte la preuve.

**Mutation obligatoire.** L'étape 3 a livré quinze tests incapables d'attraper le défaut qu'ils
nommaient, dont six trouvés par les implémenteurs eux-mêmes. Le motif ne varie pas : *le test met
en scène la bonne intention et rate la ligne qu'il nomme.* **Appliquer la mutation, ne pas la
raisonner** — un test vert dont on n'a jamais vu l'échec ne prouve rien.

**Les chiffres de réplication ne doivent pas bouger.** `apparition tardive avec rattrapage`,
`serveur vs client` et le scénario 9 restent à **0,000 px**. Rien dans cette étape ne devrait les
toucher ; si l'un bouge, c'est que le draft a fui dans la simulation répliquée, et c'est la
trouvaille.

## 9. Écarts assumés

### 9.1 Le modèle de cartes, révisé après la vérification manuelle

**C'est l'écart le plus lourd de cette étape, et il vient du jeu, pas du raisonnement.** Ce
document décrivait quatre natures de carte, des armes qui montaient de niveau jusqu'à évoluer, un
`owner` qui portait l'exclusivité, et une exclusivité d'arme à l'échelle de l'équipe. L'auteur a
joué et a corrigé :

> *« Il n'y a pas de "niveau" d'arme. Si quelqu'un a déjà pris "Lance-flammes", je peux lui "voler"
> la carte la prochaine fois. C'est l'accumulation des cartes qui fait la puissance. »*

Ce qui est tombé, et ce qui l'a remplacé :

| Retiré | Remplacé par |
| --- | --- |
| `WEAPON_LEVEL`, `EVOLUTION` | les armes s'empilent comme les passifs |
| `Weapon.maxLevel`, `evolutionPassiveId`, `WEAPON_MAX_LEVEL` | rien — plus de borne |
| `Card.owner` | `Loadout.canTake` — l'éligibilité se dérive de l'inventaire |
| l'exclusivité d'arme d'équipe | rien — chacun a son propre exemplaire |
| la fenêtre de repioche, `DRAFT_REPICK_TICKS` | l'attribution d'office, immédiate |
| l'octet `phase` de `DRAFT_RESULT` | rien — un seul message par draft |

**Ce que le modèle y gagne : il devient uniforme.** Une carte est une arme ou un passif ; tout
s'empile ; tout est ouvert à tous ; la résolution est un seul moment. Les cas particuliers qui
peuplaient les §3.2, §3.4 et §4.4 ont disparu avec ce qu'ils réglaient.

*Conséquence assumée :* le nombre de projectiles simultanés n'a plus de borne structurelle. La
tâche 7 avait mesuré 112 au pire avec cinq slots pleins et un exemplaire chacun ; l'empilement
lève ce plafond. `PROJECTILE_CAPACITY` est à re-mesurer, et `Projectiles` tronque en silence quand
elle est atteinte.

### 9.2 §7.2 point 5 — la rotation de priorité est supprimée

La résolution est un aléatoire pur. La spec d'orientation en faisait l'un des deux garde-fous
contre une mécanique vécue comme punitive ; le traitement visuel du §4.2 — la carte qui brûle, puis
celle qu'on obtient qui s'illumine — le remplace en rendant la perte lisible plutôt qu'en la
répartissant.

*Risque assumé :* un joueur peut perdre plusieurs conflits d'affilée. Borné par le fait que le
perdant repart toujours avec une carte. À revoir au playtest.

### 9.3 §7.3 — le modèle de repli est abandonné

Il prévoyait de basculer vers *trois cartes privées + une carte d'équipe* si les conflits
frustraient, et exigeait que le protocole supporte les deux sans refonte.

*Conséquence assumée :* si le playtest montre que les conflits frustrent, ce sera une refonte et
non une bascule.

## 10. Questions laissées ouvertes

- **L'équilibrage des passifs** — de combien empile une carte — est un réglage, à faire à l'œil
  comme celui des vagues à l'étape 3.
- **Le multijoueur réel n'a toujours jamais été joué** (hérité de l'étape 3). Le test modélise
  quatre clients, il ne subit pas un vrai réseau.
