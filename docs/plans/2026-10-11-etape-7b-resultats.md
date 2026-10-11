# Étape 7b — la boutique : résultats

**25 commits mesurés par le coordinateur** (de `376a692`, la spec, à `cca2618`), **plus celui-ci**
— **65 fichiers, 1 674 tests, tous verts** (45 fichiers / 1 162 tests au back, 20 fichiers / 512 au
front). Un joueur dépense son or à l'écran d'accueil, et sa run suivante en est changée — mesurable,
et prouvé sur vraies sockets.

**Spec :** [`../specs/2026-10-11-etape-7b-boutique.md`](../specs/2026-10-11-etape-7b-boutique.md)
**Plan :** [`2026-10-11-etape-7b-boutique.md`](2026-10-11-etape-7b-boutique.md)

⚠️ **Ce document est ouvert.** Le §8 attend la run de l'auteur.

## 1. Le livrable, et ce qui le distingue

L'étape 7a avait donné un compte, un solde, et la garantie que l'or survit. Elle n'avait donné
**aucune façon de le dépenser**. 7b comble ce trou, et rien d'autre.

Deux tâches prouvent deux choses différentes, et la distinction est le cœur du livrable :

- la **tâche 6** prouve que **le bonus arrive** — les cinq sites de somme existants
  (`fireRate`, `damage`, `maxHp`, `speed`, `regen`) plus le nouveau (`pickupRadius`, tâche 7)
  intègrent bien `compte.bonus(clé)`, chacun épinglé par une mutation qui rougit si le bonus est
  oublié ;
- la **tâche 9** — le livrable — prouve qu'**une run ouverte après l'achat est différente d'une
  run ouverte avant** : deux salons successifs, deux sockets réelles, un achat posé entre les deux,
  et le second `join` relit réellement le compte. La mutation `bonusesOf -> zeros` fait rougir le
  second passage (`expected 100 to be 110`) — la preuve ne tient pas sur l'intuition que la
  relecture a lieu, elle la mesure.

`back/src/boutique.integration.test.ts` — 4 tests, **5/5 lancers verts**, déterministe, ~3 s chacun.
**Campagne de mutation : 9 mutations, 9 rouges**, dont une seulement après qu'un trou ait été mesuré
et comblé (§4).

## 2. Les décisions de conception, et leur raison

### 2.1 Aucun slot vendu — et le README n'en est PAS affaibli

Le §11 de la spec d'orientation listait les slots d'armes parmi ce que l'or pourrait acheter. Pris
au mot, l'article détruisait la mécanique centrale : quatre slots couvrent 6 paires sur 15 pour un
joueur seul, cinq en couvrent 10, **six les couvriraient toutes**. La spec amende donc le §11 :
`WEAPON_SLOTS` reste une constante, et **aucun slot de passif n'est vendu non plus** — sans danger
pour le pitch, mais `PASSIVE_SLOTS` touche `shared/Loadout`, hors périmètre.

**Dis-le clairement, pour que le lecteur n'ait pas à se le demander** : la première phrase du
README — « un joueur seul ne peut pas couvrir assez d'éléments pour tout déclencher lui-même » —
**n'est pas affaiblie par cette étape**. Chaque élément garde une arme libre (§2.3 ci-dessous), et
l'assertion mesurée de l'étape 5c (`elements-5c.integration.test.ts`, quatre slots, six paires,
jamais quinze) reste exactement ce qu'elle était.

### 2.2 Les classes n'existent toujours pas

Le §11 nommait aussi des « classes supplémentaires ». `shared/classes.ts` est absent du dépôt, et
le §15.1 — qui demandait de trancher leur nombre et leurs verbes « avant l'étape 3 » — n'a **jamais**
été tranché. Il n'y a donc rien à débloquer de ce côté : les déblocages de 7b sont les six armes,
et elles seules. Le second volet de déblocage que le §11 envisageait reste sans chemin
d'implémentation.

### 2.3 Les six armes verrouillées, et pourquoi celles-là

Le dépôt porte 17 armes, deux par élément (un arroseur, un frappeur) plus cinq neutres. C'est le
**frappeur** de chaque élément qui se verrouille — un gros coup unique se vit comme une récompense,
et les arroseurs, qui appliquent l'élément plus souvent, conviennent mieux à un compte qui découvre
le système de réactions. Chaque élément garde donc son arroseur libre.

Le verrou est un champ `locked: boolean` **explicite** sur `Weapon`, pas dérivé de
`projectileCount === 1` — bien que ce prédicat coïncide aujourd'hui avec les six frappeurs. C'est la
leçon payée à l'étape 5c : une règle dérivée qui coïncide avec les données d'aujourd'hui est la
première forme du « décor qui masque ».

Le verrou ferme le **pool du draft** (`drawSpread` tire sur l'union des pools de la salle, et le
serveur refuse un jeton posé sur une carte non débloquée), pas le `Loadout` : `Room#grantCard` n'est
pas concerné, et les onze tests de 5c qui équipent une arme directement restent verts sans être
touchés.

**L'union, pas l'intersection** : une intersection dégraderait le pool de toute l'équipe au premier
débutant — exactement ce que le §8.1 de la spec interdit (« une punition se lit comme un bug »). Et
le grisage qui accompagne l'union **ne coûte aucun octet** : chaque client connaît son propre
ensemble d'armes débloquées via `GET /accounts/me`, qui rend désormais `{ gold, purchases }` — rien
de neuf ne transite sur `DRAFT_OPEN`.

### 2.4 Les améliorations permanentes réutilisent un mécanisme existant

`Room` sommait déjà `CONSTANTE + loadout.bonus(clé)` à cinq endroits. Une amélioration permanente est
la même forme, un terme de plus : `CONSTANTE + loadout.bonus(clé) + compte.bonus(clé)` — aucune
amélioration achetée ne consomme un slot de passif, c'est un terme distinct.

La sixième clé, `pickupRadius`, répond à une question laissée ouverte par l'étape 6a (« le rayon de
ramassage punit chaque gain de puissance »). C'est aussi la seule qui n'était pas déjà câblée : elle
a demandé quatre points de contact neufs (une valeur par joueur dans `Room`, la comparaison par
joueur dans `resolvePickups`, le transport par le `SNAPSHOT`, et la lecture côté client) — et c'est
elle qui casse l'invariant « zéro octet par tick » (§3).

### 2.5 Le catalogue, la table `Purchase`, et les prix comme réglage

`shared/shop.ts` déclare les articles — identifiant, prix, effet, nombre de paliers — et le front
l'importe pour l'affichage ; **aucun prix n'est lu depuis le client**, le serveur relit le catalogue,
vérifie le solde et débite en transaction. Une seconde table, `Purchase`, porte une ligne par
article possédé avec une clé composite `(accountId, itemId)` qui interdit structurellement le
doublon.

**Les prix ne sont pas équilibrés.** L'étape 7a n'a livré aucun historique de runs ; l'ancre est
calculée depuis les constantes de gain d'or, pas mesurée sur de vraies parties. C'est un réglage de
playtest, pas un invariant — aucun test n'écrit un prix en dur.

## 3. Le coût affiché, le calcul refait

⚠️ **Sept étapes consécutives sans un octet ajouté par tick s'arrêtent ici, par décision explicite
de l'utilisateur**, prise après qu'on lui ait présenté le coût et l'alternative.

`SNAPSHOT_PLAYER_BYTES` passe de **9 à 10**. À quatre joueurs, le `SNAPSHOT` passe de 58 à **62**
octets, soit **+4 octets par snapshot**, **+0,47 ko/s par salon** à 30 Hz. L'architecture du §3.3 de
la spec d'orientation a économisé environ 150 ko/s en ne répliquant pas les positions de la horde —
ce surcoût en représente **0,3 %**.

**La marge du `u8`, calculée et non devinée : 85, pas 165.** `ORB_PICKUP_RADIUS` vaut 90, et le
seul article qui porte `pickupRadius` (l'aimant) a 4 paliers de 20 chacun, donc un bonus maximal de
80 — maximum atteignable **170**, plafond d'un octet non signé **255**, marge **85**. Le plan
portait d'abord 165, en soustrayant la base du plafond et en **oubliant le bonus** : ça aurait été le
douzième docbloc faux de ce dépôt, livré par l'auteur du plan lui-même. Un test dérive cette marge
du catalogue plutôt que de l'écrire en dur, pour qu'un article de rayon ajouté plus tard fasse
rougir ce test au lieu de déborder l'octet en silence.

**L'alternative écartée, et son coût réel** : ne prédire la capture que pour soi-même aurait coûté
zéro octet, au prix d'une orbe ramassée par un coéquipier qui se serait animée un aller-retour plus
tard — une régression sur une finition que l'étape 6a avait justement travaillée. L'auteur a préféré
payer en octets.

## 4. La septième forme du « décor qui masque »

Ce dépôt en nommait six. L'étape en ajoute une septième, trouvée par la revue du livrable (modèle le
plus capable, choisi parce que le livrable est le seul artefact dont un faux vert invaliderait la
revendication de toute l'étape) : **« la mesure prise puis jamais comparée »**.

Le livrable mesurait la taille réelle de `DRAFT_OPEN` sur une ouverture réelle — exactement comme
exigé — mais n'assénait que sa **cohérence interne** : `expect(new Set(taillesDraft).size).toBe(1)`.
Un message grossi d'un masque d'éligibilité aurait été uniforme lui aussi, donc vert. **Mesuré** :
faire passer `DRAFT_OPEN_HEADER_BYTES` de 6 à 7 laissait **le livrable ET `protocol.test.ts`
entièrement verts.** Le trou était antérieur à l'étape : `protocol.test.ts` calculait ses attentes
avec la constante qu'elle vérifiait — seul `DRAFT_CARD_BYTES` y était épinglé en nombre nu.

**Le correctif** : l'assertion de taille du livrable est devenue un nombre nu (`=== 16`, dérivé du
décor à deux joueurs — 6 d'en-tête + 5 cartes × 2 ; le docbloc dit qu'elle vaudrait 20 à quatre
joueurs), et `DRAFT_OPEN_HEADER_BYTES === 6` a été épinglé dans `protocol.test.ts`, qui en était
dépourvu. Deux défauts connexes, trouvés par la même revue et corrigés dans le même commit : une
égalité stricte entre un délai de test (20 000 ms) et `DRAFT_WINDOW_TICKS` (600 à 30 Hz) sans marge,
relevée à 30 000 ; et deux `?? 0` qui auraient effondré une paire discriminante en silence si
`perLevel` venait à disparaître, remplacés par un `throw` explicite.

## 5. Les chiffres du portique, mesurés par le coordinateur

Lancé sur l'état final de la branche, `cca2618` :

| Mesure | Valeur |
| --- | --- |
| Back | 45 fichiers, 1 162 tests, tous verts — 292 s |
| Front | 20 fichiers, 512 tests, tous verts — 5,2 s |
| Total | 65 fichiers, 1 674 tests |
| `npm run lint` | vert, 146 fichiers vérifiés |
| `npm run typecheck` | vert (front + back) |
| Commits de l'étape | 25, de `376a692` (la spec) à `cca2618` |

**Le contrat de réplication tient toujours à 0,000 px**, sur chaque scénario avec rejeu — VF2, CF2,
GF2, MV2, AV2, 11c, et l'échelle de l'étape 6a. Sept étapes après avoir été posé, et malgré
l'élargissement du snapshot de cette étape-ci.

**La campagne de mutation de la tâche 9 : 9 rouges sur 9**, dont une seulement après qu'un trou ait
été mesuré et comblé (§4).

## 6. Les erreurs du plan, et qui les a trouvées

C'est la section qui rend ces documents utiles. Le compte honnête : **six fois un implémenteur ou
un relecteur a corrigé le coordinateur, et six fois il avait raison.**

| Tâche | Défaut (de l'auteur du plan, sauf mention contraire) | Trouvé par |
| --- | --- | --- |
| 4 | Verrou de clé composite protégeant l'**insertion** seule : un article à **palier ≥ 2** permettait un double débit réel. Le test de concurrence du brief choisissait délibérément un article à un seul palier — il n'exerçait jamais la branche fautive. | Le relecteur, mesuré (24/25 essais identiques, double débit confirmé) |
| 5 | Trois défauts, les trois de l'auteur du plan : une assertion creuse sur le refus 400 (les trois payloads testés passaient sans la garde), un verdict `'conflit'` non traité tombant dans le `200` final (un refus rapporté comme un succès), et un test du 402 qui ne vérifiait pas ce qu'il prétendait (compte à solde nul, assertion trivialement vraie). | L'implémenteur, pour les deux premiers ; le coordinateur lui-même en relisant son propre commit, pour le troisième |
| 6 | Quatre erreurs de plan trouvées au pré-vol, dont **un site de code entièrement manqué** : `join` initialisait les points de vie sans aucun bonus, alors que la décision est « statistiques de départ seulement ». Plus **une mutation de preuve impossible imposée deux fois** avant que l'implémenteur ne soit cru. | Pré-vol du coordinateur contre le code réel ; l'implémenteur, pour la mutation impossible |
| 7 | Un nombre faux dans un docbloc (la marge du `u8` : 165 au lieu de 85), un test que l'amendement du coordinateur interdisait explicitement dix lignes plus haut et que le brief contenait pourtant, et **deux Critiques** (l'indexation par joueur jamais prouvée) que la première ronde de revue avait manqués. | L'implémenteur pour le test interdit ; une revue au modèle le plus capable pour les deux Critiques |
| 8 | Deux erreurs de plan (un chemin de code mal identifié, une garde manquante sur `stage.init` héritée de 7a), une assertion creuse (« 402 et 409 diffèrent », qui survivait à l'échange des deux branches), et **une exigence de la spec que le plan avait laissée tomber** : le grisage du draft, sans lequel le joueur clique sur une carte débloquée par un coéquipier et rien ne se passe. | L'implémenteur pour les trois premiers ; le coordinateur, en relisant la spec, pour le quatrième |
| 9 | Une moitié positive oubliée dans le brief (le refus seul ne prouve pas qu'il vise la bonne personne), un `?? 0` qui aurait pu creuser une paire discriminante en silence, **un invariant présenté comme LE garde-fou de l'étape et qui ne gardait rien** (`base + maxBonus <= 255` ne détecte pas un `maxBonus` sous-estimé — un plafond trop petit rend l'inégalité plus vraie), et le Critique de la septième forme (§4). | L'implémenteur pour le `?? 0` et l'invariant creux ; une revue au modèle le plus capable pour la septième forme |

**Ne pas romancer ce bilan, et ne pas le minimiser non plus.** Sa valeur est d'être exact : il dit
que le filet — pré-vol contre le code réel, mutation appliquée et non raisonnée, revue indépendante
— a attrapé des défauts que l'auteur du plan ne voyait pas, y compris dans ses propres instruments
de mesure (le test du `u8`, l'invariant de la tâche 9, le docbloc de la marge).

## 7. Écarts assumés

Repris du §8 de la spec, actualisés :

- **Le `SNAPSHOT` grossit de 4 octets à quatre joueurs** (§3). Sept étapes sans un octet ajouté par
  tick s'arrêtent ici, par décision explicite.
- **Les prix ne sont pas équilibrés**, faute d'historique de runs. Réglage de playtest.
- **Pas de slot vendable**, ni d'arme, ni de passif (§2.1).
- **Pas de classe**, puisqu'il n'en existe aucune (§2.2). Le §15.1 reste ouvert, et c'est désormais
  la seule partie du §11 de la spec d'orientation qui n'a aucun chemin d'implémentation.
- **Pas de remboursement, pas de remise à zéro.** Un achat est définitif.
- **Un achat n'est pas annonçable en cours de run** : les améliorations s'appliquent à la run
  suivante, parce qu'elles sont lues à la poignée de main. Voulu — changer les statistiques d'un
  joueur en pleine partie demanderait de les faire voyager sur le fil.
- **`POST /accounts` n'a toujours aucun plafond par IP** (écart hérité de 7a).

## 8. Vérification manuelle

⚠️ **Section ouverte — attend la run de l'auteur.**

Ce que les tests ne peuvent pas juger :

1. **La boutique à l'écran d'accueil** : les prix se lisent-ils bien, et l'effet d'un achat se
   sent-il dès la run suivante ?
2. **Le grisage des armes verrouillées**, dans l'étalage comme dans le draft : est-il assez visible
   pour qu'un joueur comprenne pourquoi une carte ne réagit pas au clic, sans se lire comme une
   punition ?
3. **Les messages 402 / 409** à l'achat : distinguent-ils vraiment « gagne plus d'or » de
   « rafraîchis et retente », pour un joueur qui ne lit pas le code ?
4. **La courbe de prix** : les six articles se sentent-ils accessibles dans l'ordre voulu, ou
   est-ce que l'aimant (le plus cher) se paie trop vite ou trop lentement par rapport aux runs
   réelles ?
5. **Le rayon de ramassage personnel** : une orbe lâchée par la mort d'un ennemi loin d'un joueur
   au rayon amélioré se ramasse-t-elle de façon lisible, sans paraître téléguidée ?

## 9. Questions laissées ouvertes

Reprises et actualisées depuis le §9 de la spec :

- **Combien de paliers par amélioration, et quelle courbe de prix ?** À régler au playtest, avec les
  cinq runs désormais dues (§10).
- **Le §15.1 — les classes.** Toujours pas tranché, et c'est maintenant la seule partie du §11 de la
  spec d'orientation qui n'a aucun chemin d'implémentation.
- **Faut-il montrer aux autres joueurs ce qu'on a débloqué ?** Le grisage est privé dans cette
  étape — un étalage qui montrerait « deux joueurs peuvent prendre cette carte » rendrait la
  négociation du §7.1 de la spec plus riche, au prix d'octets.

## 10. Dette reportée

- **Cinq parties à jouer sont désormais dues** : 5b §4, 6a §3, 5c §12, 7a §10, et celle-ci (§8).
  Aucune n'a encore reçu la run de l'auteur.
- **L'atlas de monstres dérivé n'est toujours pas sur MinIO** — la production perdrait toute la
  horde. Dette héritée, non créée par cette étape, confirmée toujours ouverte.
- **Le chemin de la salle pleine n'est testé nulle part.** L'étape 7a a déplacé le moment de sa
  détection (le slot se prend après le `HELLO`, plus avant), et la tâche 6 de cette étape a changé
  la signature de `Room#join` sans toucher à ce contrat — vérifié que le contrat survit (`join` rend
  `false` avant toute mutation de l'état des joueurs), mais rien ne le garde par un test.
- **L'angle mort de `maxBonus`** : tant que l'aimant reste le seul article portant `pickupRadius`,
  un `maxBonus` qui prendrait le **maximum** au lieu de la **somme** des articles reste indétectable.
  Rien de mieux n'est faisable sans écrire `80` en dur, ce que la doctrine du dépôt interdit. Le
  docbloc du test l'assume déjà plutôt que de le cacher.
