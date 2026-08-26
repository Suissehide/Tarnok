# Étape 3 — le combat : résultats

80 commits, 342 tests (262 back, 80 front). Une run solo se joue de bout en bout : on tire, les
ennemis meurent, on ramasse, on monte de niveau, on finit par mourir.

**Spec :** [`../specs/2026-08-24-etape-3-combat.md`](../specs/2026-08-24-etape-3-combat.md)
**Plan :** [`2026-08-24-etape-3-combat.md`](2026-08-24-etape-3-combat.md)

Le plan comptait treize tâches en partant. Il en compte vingt-huit. **Les quinze ajoutées
viennent toutes de l'auteur en train de jouer**, et aucune n'aurait été trouvée autrement.
C'est le résultat principal de cette étape, plus encore que les chiffres ci-dessous.

## 1. Le livrable : la réplication survit aux morts

L'étape 2 avait prouvé que mille ennemis convergent identiquement à partir d'un message de
19 octets. L'étape 3 mettait ça en danger deux fois : la **séparation couple** les entités —
retirer un ennemi en déplace des dizaines — et les **morts arrivent en retard**.

| Scénario | Dérive maximale |
| --- | --- |
| Morts + séparation, **sans** rejeu | **332,888 px** |
| Morts + séparation, **avec** rejeu | **0,000 px** |
| Mort sortie de l'anneau, appliquée au présent et signalée | **93,007 px** |
| Apparition tardive, **sans** rattrapage | 430,569 px |
| Apparition tardive, **avec** rattrapage | **0,000 px** |
| Tick local jamais recalé (défaut C1 de l'étape 2) | 544,360 px |
| Idem, corrigé | **0,000 px** |

216 morts sur 1000, horde déplacée de 1499 px. Une dérive de zéro sur une horde immobile ne
vaudrait rien : ces deux chiffres sont là pour qu'on puisse le vérifier.

**Les lignes « sans correction » comptent autant que les zéros.** Elles mesurent ce que le
mécanisme ferait sans ses parades, et ce sont elles qui justifient la machinerie.

> **Ces chiffres ont baissé de moitié en cours d'étape, et pour une raison instructive.** Le
> scénario sans rejeu valait 687 px avant la tâche 25, qui a remplacé la lecture du champ de flux
> par une interpolation. Le champ discret n'amplifiait pas seulement l'oscillation visible : il
> **amplifiait la divergence elle-même**. Une différence de position d'un pixel donnait une
> direction radicalement différente ; elle donne désormais une direction légèrement différente.

**Les trois convergences sont restées à 0,000 px à travers les vingt-huit tâches** — y compris
quand le modèle de déplacement a changé trois fois (poussée bornée, puis vitesse tenue par
intervalle, puis pilotage par déviation). C'est ce que ce test devait prouver.

## 2. La porte de performance

Le §3.3 de la spec engageait trois issues **avant** la mesure, pour ne pas trancher sous la
pression du résultat.

| Rejeu de 3 ticks à 1 500 entités | Verdict |
| --- | --- |
| Première exécution | 4,56–4,95 ms → **rouvrir le §3.2** |
| Après correction de `SEPARATION_STRENGTH` | 1,12 ms → « à borner » |
| **État final** | **3,60 ms → « à borner »** |

**La porte avait d'abord sauté pour une constante fausse, pas pour l'architecture.** À 120 px/s
la répulsion perdait contre le flowfield : l'équilibre n'était jamais atteint, la densité montait
tant que des monstres arrivaient, et le coût — qui croît avec le **carré** de la densité —
explosait.

Le tableau « Cohérence des constantes » du plan donnait cette constante comme « réglage de
sensation, sans effet sur le déterminisme ». Vrai pour le déterminisme, faux pour le coût, dont
c'était le principal levier. **Un tableau de contraintes ne protège que si les contraintes qu'on
y écrit sont les bonnes.**

### Ce qui reste ouvert

À 4 000 entités, le rejeu coûte **13,86 ms** — verdict « rouvrir le §3.2 ». La cible du §4.1 est
1 500 entités, et on y est ; en conditions réelles la horde plafonne entre 500 et 1 100 depuis
que les vagues montent progressivement. **Mais le plafond dur de `MAX_ENTITIES` n'est plus
tenu**, et il vaut mieux le savoir que le découvrir.

## 3. Bancs

| | |
| --- | --- |
| Simulation, 4 000 entités | pas p95 **1,94 ms** — verdict OK |
| Séparation, 1 500 entités | pas 0,90 ms, rejeu ×4 **3,60 ms**, équilibre atteint |
| Saut maximal d'une entité | **7,17 px** par tick — borné par construction |
| Réseau, 4 joueurs réels | **1,09 ko/s par joueur**, un cœur saturé vers 55 salons |

Le trafic reste sans rapport avec le nombre d'entités, comme l'exige le §3.3.

## 4. Ce que la vérification manuelle a trouvé

**C'est la section la plus importante de ce document.** La run a été jouée par l'auteur. Chaque
ligne ci-dessous est un défaut réel qu'aucun test ne pouvait voir, parce que tous mesuraient la
simulation — où tout fonctionnait.

| Signalé par l'auteur | Ce que c'était |
| --- | --- |
| « Trop de monstres » | Générateur de vagues resté calibré pour un test de charge du rendu : ~37 apparitions/s contre 2 morts/s |
| « Les monstres sont minuscules » | Échelle dérivée de la **cellule d'atlas** au lieu du **corps** de la créature |
| « Les hitbox sont mauvaises » | Sprites dessinés à 192 px pour une hitbox de 64 |
| « Un gros souci de clignotement » | Bande de tri de profondeur de 64 px, justifiée par un raisonnement retourné |
| « Ils se téléportent » | Forces de répulsion sommées sans borne : 96,8 px en un tick |
| « Des monstres immobiles » | **Deux** défauts du champ de flux — aucun dans l'évitement |
| « La carte est complètement noire » | Obstacles jamais dessinés |

### Le cas qui résume tout

Les monstres immobiles ont occupé **six tâches** (18 à 23), toutes cherchant la cause dans la
répulsion entre monstres. Elle n'y était pas.

Elle était en deux morceaux :

1. **Le champ de flux est discret.** Une direction par cellule de 64 px : franchir une frontière
   pouvait retourner la direction de 180°. Mesuré sur un monstre **seul, sans aucun voisin** :
   1282 demi-tours sur 400 trajets, 9108 sur cible immobile. Après interpolation : 276 et **0**.

2. **Un joueur sur un obstacle vidait tout le champ.** `FlowField.update` amorce son parcours
   depuis la cellule du joueur ; bloquée, il n'explore rien. **0 cellule atteinte sur 8836.**
   Tous les monstres de la carte perdaient leur direction au même instant.

Et le second n'était irreproductible que parce que **les rochers n'étaient pas dessinés** : il
fallait marcher sur un obstacle invisible.

> Aucune sonde ne pouvait trouver ça. Toutes portaient sur la simulation, où les obstacles
> existent et où le joueur est un point qui ne marche pas dessus par accident. Il a fallu trois
> phrases : « celui-là est tout seul », « c'est toujours au même endroit », « la carte est
> noire ».

### Trois décisions de conception prises par l'auteur contre la spec

- **La visée suit le curseur**, contre le §5.3 qui prévoyait une visée automatique. La direction
  cesse d'être dérivable : elle transite dans `INPUT` (5 → 7 octets) puis se redistribue dans le
  `SNAPSHOT`, parce que chaque client dessine aussi les tirs de ses alliés. 240 o/s à quatre
  joueurs.
- **Les monstres s'arrêtent pour attaquer** au contact, au lieu de traverser le joueur.
- **Le déplacement se recalcule par intervalle**, chaque entité tenant son cap 300 ms — observé
  dans un jeu de référence par l'auteur, et six fois moins cher que le recalcul par tick.

## 5. Quinze tests qui ne testaient rien

**Quinze tests écrits dans ce plan se sont avérés incapables d'attraper le défaut qu'ils
nommaient.** Aucun n'était visible à la lecture. Tous l'étaient en cassant le code. **Six ont été
trouvés par les implémenteurs eux-mêmes**, cherchant des mutations survivantes de leur propre
initiative.

| Le test | Ce qu'il ne voyait pas |
| --- | --- |
| « n'alloue pas à chaque appel » | mille appels dans `not.toThrow()` |
| « ne touche pas au-delà du rayon » | entités à deux cellules d'écart : la paire n'était jamais examinée |
| « emmène toutes les propriétés » | vérifiait 2 des 7 tableaux |
| filtre `slot >= 0` | masqué par coïncidence avec le garde voisin |
| dérivation des salves | comparait **deux tableaux vides** |
| réplication, scénario 9 | morts toujours sur une frontière de rafraîchissement |
| `#drainPendingDeaths` | jamais deux lots au même tick |
| `orbs.expire` | aucun test — les orbes pouvaient ne jamais disparaître |
| prédiction locale du tir | jeter la position prédite laissait 18 tests verts |
| tir pendant le gel | tirer pendant le gel laissait 18 tests verts |
| `bandOf(63) === 0` | gardait la **valeur d'une constante**, pas un comportement |
| symétrie de la séparation | passait aussi sans le garde qu'elle prétendait couvrir |
| gel de niveau côté client | le paramètre existait, le câblage non — 76 tests verts, fonction morte |
| cas dégénéré du pilotage | premier jet incapable d'attraper sa propre mutation |
| « accumuler puis appliquer en bloc » | aucun scénario ne produit d'ordre de tableau divergent |

**Le motif ne varie pas : le test met en scène la bonne intention et rate la ligne qu'il nomme.**
Deux ont été trouvés parce qu'un *chiffre* était suspect, pas parce que le code se lisait mal.

La leçon opérationnelle : **appliquer la mutation, ne pas la raisonner.** Un test vert dont on
n'a jamais vu l'échec ne prouve rien.

## 6. Onze erreurs du plan, corrigées par les implémenteurs

Le plan s'est trompé plus souvent que le code, et **chaque fois l'implémenteur a signalé la
contradiction au lieu de choisir en silence.** Les plus coûteuses :

- **L'ordre du tick** : le brief inversait rafraîchissement et engendrement ; le code éprouvé
  faisait l'inverse depuis l'étape 2.
- **L'auto-visée sur `T − K`** : le retard fonctionne pour le flowfield parce qu'il porte sur des
  positions **répliquées**. Le ciblage dépend de la horde, *dérivée*, dont le désaccord vient de
  la propagation des morts. J'avais emprunté un mécanisme qui résout un problème pour l'appliquer
  à un autre.
- **La contrainte anti-tunnel** : une parade *numérique* à un problème *géométrique*. Elle ne
  protégeait que les cibles pile sur l'axe de tir. `collide` balaie désormais le segment, et la
  contrainte a été supprimée **avec son test**.
- **Le rejeu des projectiles** : leur position ne dépend que de leur vitesse ; les rejouer les
  faisait avancer **deux fois**.
- **L'expérience portée par joueur** alors qu'elle est celle de l'équipe — deux sources de vérité
  pour un seul nombre.

Trois de mes propres sondes de diagnostic étaient fausses de la même façon :
`generateObstacles(seed)` appelée avec un argument sur trois rend un masque **vide**. J'ai
rapporté « zéro cellule bloquée » deux fois avant de m'en apercevoir — exactement le défaut que
je faisais traquer aux implémenteurs.

## 7. Ce qui reste ouvert

- **Le plafond de 4 000 entités n'est plus tenu** (13,86 ms de rejeu, contre 3,60 à la cible de
  1 500). À traiter si la horde doit vraiment y monter.
- **Le multijoueur réel n'a jamais été joué** : la spec §13 demande quatre vrais clients sur un
  vrai réseau. Le test de réplication modélise la latence, il ne la subit pas.
- **`shared/targeting.ts` et `Projectiles.fireSalvo` n'ont plus d'appelant** depuis la visée au
  curseur. Conservés pour l'étape 4, et **annotés comme tels**.
- **`Horde.slotOf` est un balayage linéaire** ; `Projectiles.collide` est en
  O(projectiles × entités). Mesurer avant de remplacer.
- **Le réglage n'est pas fini.** Le test « le niveau 2 est atteignable » garde ce qu'il annonce,
  pas la *qualité* du réglage — cette distinction est réelle, et c'est l'œil de l'auteur qui en
  tient lieu.
