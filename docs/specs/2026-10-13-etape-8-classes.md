# Étape 8 — les classes : un verbe et un trait

## 0. Statut et dépendance

Cette étape tranche le **§15.1 de la spec d'orientation**, la dernière partie du §11 à n'avoir
aucun chemin d'implémentation. Le §15.1 disait « à trancher avant l'étape 3 » ; nous sommes après
7b. Le retard joue en notre faveur : quatre des six verbes esquissés s'appuient sur des systèmes
construits depuis — les zones au sol (5a-5c), la Synergie, l'armure, les réactions.

⚠️ **Dépendance dure, non committée au moment d'écrire.** Une **salle d'attente** est en cours de
construction dans l'arbre de travail : trois messages (`LOBBY: 21`, `PICK: 22`, `START: 23`), un
`startingWeapons()`, un `NO_WEAPON = 255`, et un écran `front/src/ui/room.ts`. Cette étape **s'y
branche** : le choix de classe rejoint l'écran qui existera alors. Elle ne peut donc pas commencer
avant que ce travail soit committé et vert. Si la salle d'attente devient une étape numérotée, le
numéro de celle-ci se décale.

## 1. Le livrable en une phrase

**Chaque joueur choisit une classe au salon, et cette classe lui donne une capacité active que le
serveur arbitre et que les deux côtés dérivent identiquement.**

Vérifiable ainsi : une partie où un verbe est utilisé garde une dérive de **0,000 px** entre le
serveur et le client, et un joueur qui change de classe change de verbe sans qu'aucun octet de plus
ne transite par tick.

## 2. La prémisse a changé, et il faut le dire

Le §6.7 de l'orientation posait : *« Une classe apporte un verbe et un trait passif. Jamais un
élément, jamais une arme. »* Sa **raison** était que l'élément devait rester l'enjeu du draft :

> Une classe qui fixerait l'élément de départ entrerait en conflit frontal avec l'exclusivité des
> armes (§6.2) et retirerait au draft ce qui en fait le cœur du jeu.

**Cette raison est caduque.** La salle d'attente fait désormais choisir l'arme de départ — donc
l'élément — avant la partie. L'interdit de l'arme signature est levé par décision explicite.

**La conclusion tient quand même, et mieux qu'avant.** Puisque le salon traite déjà l'arme, la
classe a un métier propre et sans recouvrement : un verbe et un trait. Ce qui tombe, c'est
l'argument ; ce qui reste, c'est la division du travail — et elle est maintenant nette au lieu
d'être défensive.

**Conséquence sur le §6.7 à acter :** la phrase « jamais un élément, jamais une arme » reste vraie
de la **classe**, mais plus du **salon**. La négociation lourde des éléments s'est déplacée du
premier étalage vers l'écran d'attente. Le §6.7 doit être amendé en ce sens, et le §7.1 relu : le
draft reste la négociation des armes **suivantes**, plus celle de la première.

## 3. Le modèle

`shared/classes.ts` — quatre entrées gelées :

```ts
export interface GameClass {
  readonly id: number;
  readonly label: string;
  readonly verb: VerbKind;
  readonly trait: TraitKind;
}
```

⚠️ **Aucun champ d'élément ni d'arme — pas par convention, parce que le type n'en a pas.** C'est la
leçon de la tâche 1 de l'étape 7b : un test qui cherchait un motif textuel pour prouver qu'aucun
slot d'arme n'était vendu était du **théâtre**, parce que le garde structurel était le système de
types. Même discipline ici : si une classe ne doit jamais porter d'arme, le type ne doit pas
pouvoir en porter une.

`VerbKind` et `TraitKind` sont des unions littérales, pas des nombres nus, pour que l'ajout d'un
verbe sans son effet fasse rougir le typecheck — comme le garde d'exhaustivité ajouté à la route
d'achat de 7b, où un verdict non traité tombait sinon dans un `200` silencieux.

## 4. Le choix au salon

Le choix de classe rejoint le message `PICK` qui portera déjà l'arme : **un octet de plus sur un
message échangé une fois avant la partie**, jamais par tick. `LOBBY` le diffuse comme il diffuse
déjà l'arme de chacun, pour que la négociation ait de quoi se tenir.

**Les doublons sont libres.** Deux joueurs peuvent prendre la même classe. Raison : le §6.7 veut
que le salon reste *« plus léger et plus lisible »*, et le projet a déjà une couche de rareté avec
l'exclusivité des armes. Une seconde couche ferait du salon une seconde négociation lourde. La
négociation porte donc sur la **couverture** — « deux Remparts et aucune Amorce » — jamais sur la
revendication d'un jeton. Et personne n'est privé du verbe qu'il voulait parce qu'un autre a cliqué
avant.

**Un joueur qui ne choisit pas** reçoit la classe par défaut (`id` 0, Amorce). Même discipline que
`NO_WEAPON` : l'absence de choix est un état valide, jamais un blocage du départ.

## 5. Le verbe : le client propose, le salon arbitre

Deux messages, aux identifiants **24** et **25** — les premiers libres après la salle d'attente :

| Message | Sens | Contenu |
| --- | --- | --- |
| `ABILITY: 24` | C → S | le joueur demande son verbe, daté par tick, avec son point de visée si le verbe en a besoin |
| `ABILITY_USED: 25` | S → C | le salon **annonce** le verbe accepté : qui, quel verbe, à quel tick, avec quels paramètres |

**« Annonce une fois, dérive ensuite. »** Le serveur n'envoie jamais l'effet, seulement son
déclenchement. Les deux côtés le calculent ensuite à partir de la même donnée datée. C'est le
patron de `BOSS_CHARGE`, et il est éprouvé : la charge déplace le boss de **2700 px par ses
couloirs** et la dérive mesurée reste à **0,000 px** (scénario 11c de
`shared/horde.replication.test.ts`).

**Le refus est silencieux**, comme pour le jeton de draft et le vote : un verbe demandé hors
recharge n'est simplement pas enregistré, et le client le verra à la prochaine diffusion. Aucun
client ne décide de quoi que ce soit.

**La recharge vit dans `PlayerState`**, à côté de `lastFireTick` qui y est déjà — un `lastAbilityTick`
du même tissu. Elle n'est **pas** dans l'instantané : le client connaît le tick de son dernier
usage, puisqu'il a reçu l'annonce, et la recharge est une constante partagée. Zéro octet par tick.

## 6. Les quatre classes

Trois des quatre verbes retenus sont tournés vers l'équipe, et le quatrième aussi. **La case
offensive reste vide à dessein** : chaque joueur a déjà une arme qui fait des dégâts, et c'est la
chose la moins intéressante qu'un verbe puisse faire. Le §6.7 l'écrit lui-même — sans cette
discipline *« on obtient quatre variantes de je fais des dégâts »*.

| Classe | Verbe | Trait |
| --- | --- | --- |
| **Amorce** | pose l'élément de votre arme en zone, **sans dégâts** | toute réaction déclenchée dans votre zone laisse un effet au sol, pas seulement trois sur quinze |
| **Rempart** | zone où les alliés encaissent moins | votre réduction de dégâts protège aussi l'allié adjacent |
| **Appât** | plante un leurre que les monstres ciblent | votre leurre porte l'élément de votre arme |
| **Relais** | se téléporte vers un allié, ou l'attire à soi | l'allié concerné est brièvement intangible |

### 6.1 Les traits changent une RÈGLE, jamais un nombre

⚠️ **Contrainte dure, et elle vient de l'étape 7b.** La boutique vend déjà des bonus **chiffrés** de
statistiques de départ : vitalité, célérité, cadence, puissance, aimant. Si le trait d'une classe
était lui aussi un nombre, une classe deviendrait « un article de boutique gratuit, plus un verbe »,
et les deux systèmes se marcheraient dessus.

Chaque trait ci-dessus change donc une règle que la boutique **ne peut pas vendre**, et chacun
renforce le verbe de sa propre classe plutôt que de s'y ajouter au hasard.

### 6.2 Les points d'accroche, vérifiés dans le code

**Amorce** — une zone naît aujourd'hui **uniquement d'une réaction**. `ZoneField` porte déjà la
notion de `kind` à **réaction nulle**, pour les appelants qui ne connaissent aucun type de réaction.
Amorce est donc une zone de réaction nulle, et le concept existe.

⚠️ **Son trait a été redessiné une fois, et il faut dire pourquoi.** La première version disait
« votre zone survit à la réaction qu'elle déclenche ». Vérification faite dans le code :
`ZoneField#removeAt` n'est appelée que depuis `expire(tick)`, qui retire les zones **dont la durée
de vie a expiré** — expiration dérivée du `bornTick`, aucun message. **Une réaction ne consomme donc
jamais la zone qui l'a déclenchée : toutes y survivent déjà.** Ce trait n'aurait rien fait — un
mécanisme mort, le défaut dont l'étape 5c a documenté quatre cas.

La version retenue s'appuie sur une règle qui existe : le §6.4 veut que **trois réactions sur quinze
laissent un effet au sol**, et c'est le cas. Le trait d'Amorce étend ce comportement aux quinze,
dans ses propres zones. Le mécanisme est en place, la règle change, et aucune boutique ne peut
vendre ça.

**Rempart** — `resolveContact` (`back/src/combat.ts`) réduit déjà les dégâts reçus :

```ts
player.hp = Math.max(0, player.hp - CONTACT_DAMAGE * (1 - (player.armor ?? 0)));
```

C'est **le site unique où un joueur perd des PV**, et le point d'accroche y est déjà. Rempart est
donc une zone qui alimente `player.armor` pour les alliés à l'intérieur. Aucune seconde formule de
dégâts n'est créée : c'est la même discipline que `appliquerDegats`, dont le docbloc dit que deux
formules d'armure divergeraient et que *« le jour où elles divergent, c'est un test qui manque, pas
un bug qui se voit »*.

⚠️ **Et la règle de combinaison est tranchée ici, parce qu'elle décide d'un abus.** La boutique vend
déjà `Armure` (`'armor'`, cinq paliers), donc `player.armor` est **déjà non nul** avant toute zone.
L'armure du compte et la réduction de Rempart se combinent par **MAXIMUM, jamais par une somme** —
exactement la règle que `ZoneField` applique déjà entre deux zones, et pour la même raison que son
docbloc donne : deux flaques qui se recouvrent *« ne doublent pas : elles donnent la plus forte »*.
Une somme ferait de « cinq paliers d'Armure achetés, plus un Rempart » une quasi-immunité, et
l'abus serait d'autant plus difficile à voir qu'il se paie en or.

**Appât** — ⚠️ **ce n'est PAS un déplacement de monstres**, et la distinction décide du risque de
l'étape. Le champ de flux est alimenté par les positions de joueurs **retardées**
(`FIELD_INPUT_DELAY_TICKS = 3`), lues de `PlayerHistory`, identiques des deux côtés **par
construction** — le serveur s'impose le retard qu'il infligera au client. Et la réaffectation
assigne chaque entité **au joueur le plus proche**, à `FLOWFIELD_HZ = 10`, pas à chaque tick.

Un leurre est donc **un point de plus qui compte comme cible**. Il ne bouge pas, contrairement à un
joueur : aucun historique n'est nécessaire, seulement « leurre en (x, y) du tick T au tick T+N »,
annoncé une fois. C'est strictement moins cher que le verbe **Appel**, qui aspirerait les monstres
et est écarté de cette étape pour cette raison.

**Relais** — déplace un **joueur**. Les joueurs sont répliqués par position dans l'instantané, pas
dérivés : aucun problème de générateur. Mais le client **prédit** son propre déplacement, donc le
Relais doit être réconcilié comme l'est le reste. C'est le verbe le plus délicat des quatre, et le
seul à toucher la prédiction.

## 7. Le coût sur le fil

| Poste | Coût |
| --- | --- |
| La classe de chacun | **1 octet par joueur, une fois**, sur `PICK` et `LOBBY` — avant la partie |
| L'annonce d'un verbe | une trame `ABILITY_USED` **par usage**, jamais périodique |
| La recharge | **zéro** — constante partagée, le client connaît le tick de son annonce |
| L'instantané | **zéro octet de plus.** `SNAPSHOT_PLAYER_BYTES` reste à **10** |

⚠️ **L'instantané ne bouge pas, et c'est une exigence de cette étape, pas un espoir.** L'étape 7b a
payé un octet par joueur par tick après que son coût ait été présenté et accepté ; il n'y a aucune
raison d'en payer un second ici, puisque rien dans un verbe n'a besoin d'être répété à 30 Hz. Un
livrable mesure la taille réelle de `DRAFT_OPEN` et de l'instantané sur une partie où les verbes
sont utilisés — **et la compare à une valeur**, pas seulement à elle-même. C'est la septième forme du
« décor qui masque », nommée à l'étape 7b : *la mesure prise puis jamais comparée*.

## 8. Ce qui n'est PAS dans cette étape

- **Écho** (rejoue la dernière réaction d'un allié), **Appel** (aspire les ennemis), **Fracture**
  (consomme la Synergie pour un dégât immédiat) : trois verbes gardés en réserve pour une étape
  méta, où ils seront **déblocables à l'or**.
  - **Écho n'est volontairement pas un choix de départ.** Le §6.7 le vante parce qu'il *« ne
    fonctionne littéralement pas en solo »* — mais le jeu est 1-4 joueurs, et le §8.1 pose que le
    regroupement doit être *« rentable, jamais obligatoire »* et qu'*« une punition se lit comme un
    bug »*. Un joueur seul qui choisirait l'Écho au lancement aurait un verbe mort. Comme déblocage,
    il est choisi par quelqu'un qui a déjà joué et sait ce qu'il prend.
  - **Appel est écarté par son coût**, pas par son intérêt : c'est le seul des six à déplacer des
    monstres, donc le seul à pouvoir casser le contrat tenu à 0,000 px depuis l'étape 2.
- **La plomberie de déblocage** des classes. Les quatre du lancement sont gratuites ; `ShopItem.kind`
  n'a donc pas besoin d'une troisième valeur tant qu'aucune classe n'est vendue. YAGNI.
- **Le choix de l'apparence** (`front/src/ui/skin.ts`), qui appartient à la salle d'attente.
- **Le verbe Relance** (retirer un étalage), proposé puis écarté : il résout une mauvaise main, mais
  il **contourne** la négociation du §7.1 au lieu de l'enrichir. Un verbe qui annule le cœur du jeu
  n'est pas un verbe.

## 9. Les tests et le livrable

**Un livrable par verbe**, parce que l'étape en livre quatre d'un coup et qu'un seul livrable final
ferait porter la revue sur trop de surface à la fois.

Pour chaque verbe :

1. **le serveur refuse hors recharge**, et le refus est silencieux ;
2. **l'effet est dérivé, pas envoyé** — la mutation qui remplace l'annonce par l'envoi de l'effet
   doit faire rougir ;
3. **la paire discriminante**, forme imposée par les étapes 7b : pour chaque verbe, un cas où il
   agit **et** un cas où il n'agit pas. Un test qui ne montre que l'action passerait aussi si le
   verbe agissait partout.

Et pour **Appât** et **Relais**, les deux qui touchent la simulation, l'assertion qui décide :
**la dérive reste à 0,000 px** entre serveur et client sur une partie où le verbe est utilisé
plusieurs fois, y compris au-delà de `ROLLBACK_DEPTH_TICKS = 8`.

⚠️ **Les magnitudes ne se codent jamais en dur dans un test** — rayons, durées, recharges se lisent
de leur source. En revanche les largeurs de fil et les identifiants de message s'épinglent en
**nombres nus** : un test qui importe la constante qu'il vérifie ne vérifie rien.

## 10. Risques, et deux défauts constatés avant de commencer

**Le risque principal n'est pas technique, il est de séquencement** : la salle d'attente n'est pas
committée. Cette étape ne commence pas avant qu'elle le soit.

**Deux défauts relevés dans ce travail en cours**, à corriger par lui et non par cette étape :

1. **Le choix d'arme au salon ne vérifie aucun déblocage.** Le commentaire de `MSG.PICK`
   (`back/src/server.ts`) annonce qu'un choix *« verrouillé non débloqué »* n'est pas enregistré,
   mais `libres = startingWeapons()` ne reçoit aucun compte et propose toutes les armes sauf la
   neutre. **Un joueur peut donc prendre gratuitement l'une des six armes que l'étape 7b vend à 300
   pièces.** Un docbloc qui décrit un contrôle absent est un bug — treize corrigés dans ce dépôt.
2. **`libres` n'exclut pas les armes déjà prises** par un autre joueur, malgré son nom.
   L'exclusivité du §6.2 n'est donc pas tenue au salon.

**Risque de conception à surveiller au playtest** : avec l'arme choisie au salon, le premier étalage
perd son rôle de première négociation. Le §7.1 doit être relu à la lumière de ce déplacement — ce
n'est pas l'objet de cette étape, mais elle le rend visible.

## 11. Questions laissées ouvertes

- **Les recharges, rayons et durées des quatre verbes.** À régler au playtest. Aucun chiffre de cette
  spec n'est un réglage d'équilibrage : ils seront posés comme constantes nommées, lisibles d'un
  seul endroit.
- **Combien de zones un Amorce peut-il entretenir à la fois ?** Rien ne limite aujourd'hui le nombre
  de zones simultanées d'un même joueur, parce qu'aucun joueur n'en posait volontairement. Un verbe
  qui en pose à la demande rend la question réelle — à trancher au plan, avec le coût de `ZoneField`
  mesuré plutôt que supposé.
- **Faut-il montrer la classe des autres pendant la partie**, et pas seulement au salon ? Rien dans
  le jeu n'en a besoin aujourd'hui, et ça coûterait des octets. Laissé fermé.
- **Les quatre verbes suffisent-ils à faire une négociation ?** À quatre joueurs avec doublons
  libres, une équipe peut prendre quatre fois la même classe. Le §6.7 parie que la couverture
  suffira à l'éviter sans règle. À confirmer au playtest.
