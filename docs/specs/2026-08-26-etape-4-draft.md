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
- le jeton, les intentions visibles, la résolution, la repioche ;
- 8 à 10 armes et 4 à 6 passifs — assez pour que les quatre natures de carte existent ;
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

### 3.1 Quatre natures, un seul objet

```ts
interface Card {
  nature: NEW_WEAPON | WEAPON_LEVEL | PASSIVE | EVOLUTION
  refId: number   // index dans WEAPONS ou PASSIVES — l'index EST l'identifiant
  owner: number   // 0 = ouvert a tous ; sinon le seul joueur eligible
}
```

Trois octets sur le fil. Le catalogue suit le motif du dépôt (`archetypes.ts`, `weapons.ts`) :
une table, l'index est l'identifiant, aucune correspondance à synchroniser.

### 3.2 `owner` porte à lui seul l'exclusivité

Une **arme a un seul porteur** (§6.2). Donc la carte « Lance-flammes niveau 2 » ne concerne que
lui : elle est **exclusive par construction et ne peut créer aucun conflit**. Même chose pour les
évolutions, qui exigent en plus le passif associé.

Le serveur n'a pas besoin d'une règle séparée : il refuse une sélection dont `owner` ne
correspond pas au joueur.

**Le conflit ne peut donc naître que sur une arme neuve ou sur un passif.**

### 3.3 Les armes montent, les passifs s'empilent

C'est la distinction structurante entre les deux natures :

| | Comportement | Borne |
| --- | --- | --- |
| **Arme** | monte en niveau | niveau maximum, puis évolution |
| **Passif** | **s'empile** — chaque carte prise augmente le bonus | aucune |

Modèle Risk of Rain pour les passifs. Conséquence directe : **l'étalage n'exclut jamais un passif
déjà possédé**, et toute carte de passif est convoitée par les N joueurs en permanence.

**Le conflit n'est donc pas un accident, c'est le régime normal.** C'est ce qui fait exister la
mécanique du §7.1.

### 3.4 Ce que l'étalage exclut

- les **armes déjà portées** par un membre de l'équipe — définitivement, pour toute la run (§6.2) ;
- les **armes dont les cinq slots du joueur sont pleins**, pour lui seul ;
- rien d'autre. Les passifs ne s'excluent jamais.

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

La révélation est **asymétrique et simultanée** : la même carte **s'illumine** chez le gagnant et
**se consume** chez les perdants. Chacun apprend son sort au même instant, sur le même objet.

Puis la repioche s'enchaîne, et **la carte finalement obtenue s'illumine** pour confirmer.

> Ce traitement fait le travail que la rotation de priorité devait faire dans la spec
> d'orientation : rendre la perte **lisible** plutôt que subie. On voit ce qu'on perd, on voit ce
> qu'on obtient à la place, dans la continuité du même geste.

### 4.3 La fenêtre

| | Durée |
| --- | --- |
| À plusieurs | **20 s plafonnées** (§7.4) |
| Repioche | **+5 s** |
| **En solo** | **se referme au clic** — pas de plafond |

Le solo justifie son exception. On monte de niveau toutes les ~14 s en début de run : vingt
secondes de gel à chaque fois rendraient une run solo majoritairement figée. Le §7.4 s'inquiète
déjà de ce coût à quatre joueurs.

`LEVEL_FREEZE_TICKS` valait 60 ticks (2 s) à l'étape 3, en attendant cette étape. Il est
remplacé par deux constantes, parce que ce sont deux durées différentes et non un réglage
unique :

| Constante | Valeur | Ce qui la contraint |
| --- | --- | --- |
| `DRAFT_WINDOW_TICKS` | 600 (20 s) | plafond du §7.4, **à plusieurs seulement** |
| `DRAFT_REPICK_TICKS` | 150 (5 s) | §7.2 point 4 |

En solo, aucune des deux ne s'applique : le gel dure jusqu'au clic. `LEVEL_RESUME_TICKS` (30, la
rampe de reprise) est inchangé — il vient de l'étape 3 et fonctionne.

### 4.4 Deux bornes de robustesse

**Un joueur absent ne bloque jamais.** À l'échéance, le serveur attribue d'office. Ce n'est pas
un cas rare : un onglet en arrière-plan ne rend rien mais reste connecté, et ça arrivera
constamment pendant les tests à quatre onglets.

La règle, **déterministe et sans réglage** — c'est ce que le §7.2 point 6 appelle « un score
simple » :

1. la carte dont il est le seul éligible (`owner` à son identifiant), s'il y en a une —
   c'est une montée de niveau ou une évolution, personne d'autre n'en veut ;
2. sinon la première carte libre de l'étalage, dans l'ordre du tirage.

Un joueur absent ne peut donc jamais priver un joueur présent d'une carte qu'il vise : sa
première option ne concerne que lui, et sa seconde s'efface devant tout jeton posé.

**La repioche ne peut pas boucler.** Si les perdants d'une repioche se reconflictent, pas de
troisième tour : un gagnant est tiré, les autres reçoivent l'attribution automatique. Sans cette
borne, quatre joueurs obstinés figent la partie.

## 5. Le protocole

Quatre messages, tous datés par tick.

| Message | Sens | Contenu |
| --- | --- | --- |
| `DRAFT_OPEN` | S → C | les cartes, le tick d'échéance |
| `DRAFT_TOKEN` | C → S | la carte sur laquelle je pose |
| `DRAFT_INTENTS` | S → C | qui a posé sur quoi |
| `DRAFT_RESULT` | S → C | attributions, conflits perdus, **et le tick où le gel prend fin** |

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

**Une arme au niveau maximum propose son évolution** si le passif associé est possédé (§7.5).

Sans ces trois-là, on distribuerait des cartes sans effet, et personne ne s'en apercevrait avant
l'étape 5.

## 8. Vérification

**La machine à états, sans serveur.** `back/src/draft.ts` se teste comme `combat.ts` : ouverture,
jeton posé puis déplacé, conflit, résolution, repioche, échéance, joueur absent.

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

## 9. Deux écarts assumés à la spec d'orientation

**§7.2 point 5 — la rotation de priorité est supprimée.** La résolution est un aléatoire pur. La
spec en faisait l'un des deux garde-fous contre une mécanique vécue comme punitive ; le
traitement visuel du §4.2 — la carte qui brûle puis la repioche qui s'illumine — le remplace en
rendant la perte lisible plutôt qu'en la répartissant.

*Risque assumé :* un joueur peut perdre plusieurs conflits d'affilée. Borné par le fait que la
repioche donne toujours une carte. À revoir au playtest.

**§7.3 — le modèle de repli est abandonné.** Il prévoyait de basculer vers *trois cartes privées
+ une carte d'équipe* si les conflits frustraient, et exigeait que le protocole supporte les deux
sans refonte.

*Conséquence assumée :* si le playtest montre que les conflits frustrent, ce sera une refonte et
non une bascule.

## 10. Questions laissées ouvertes

- **L'équilibrage des passifs** — de combien empile une carte — est un réglage, à faire à l'œil
  comme celui des vagues à l'étape 3.
- **Le multijoueur réel n'a toujours jamais été joué** (hérité de l'étape 3). Le test modélise
  quatre clients, il ne subit pas un vrai réseau.
