# Étape 13 — quatre paliers, et des légendaires qui coûtent

## 0. Statut et place dans la suite

Décidée le 16 octobre 2026 sur un retour de jeu de Léo : *« c'est un peu nul comme légendaire.
Prévois des rares, épiques, légendaires, on peut avoir des malus en plus des bonus par exemple »*,
puis, sur question : *« Moisson est nul, ça apporte pas beaucoup de satisfaction et ça existe
déjà »*. Le design a été validé en conversation, section par section, avant d'écrire ; ce document
le rend exact contre le code. Là où le code oblige à préciser ou à dévier, c'est dit sur place (⚠️)
et repris au §8.

- **Quatre paliers** au lieu de trois : commune, rare, **épique**, légendaire.
- **Deux familles, pas quatre** : commune et rare MULTIPLIENT une carte ordinaire (×1, ×2) ;
  épique et légendaire sont des **cartes de règle**, exclusives à leur palier, appliquées une fois.
- **Le légendaire COÛTE.** C'est sa signature : un effet énorme payé par un malus.
- **Transcendance** : PV max → 1, remplacés par un **bouclier** qui se régénère — la première
  ressource de survie du dépôt après les PV.
- **Moisson disparaît.** Elle doublait Regain : un légendaire qui est la version tiède d'une
  commune n'a pas de raison d'exister. C'est le diagnostic de Léo, et c'est la règle de sélection
  de tout le §4.
- **Les passifs ne sont plus limités** (§2.0), décidé par Léo pendant l'exécution : *« contrairement
  aux armes, on va pas mettre de limite aux passifs au lieu de limiter à 3 »*. Les armes gardent
  leurs quatre emplacements.

### ⚠️ Elle se rebase sur les étapes 11 et 12, en vol au moment d'écrire

Deux arbres de travail tournaient quand ce document a été rédigé : `etape-11-porteur` et
`etape-12-trajectoires`. **`etape-11-porteur` modifie déjà `shared/rarity.ts` et
`shared/cards.ts`** — les deux fichiers centraux de cette étape-ci. Ce document est donc écrit
contre **l'état d'après-11**, pas contre `main` :

- `rollRarity(rng, floor)` et `drawSpread(loadouts, rng, floor)` prennent déjà un plancher ;
- `CHEST_RARITY_FLOOR = RARITY.RARE` existe déjà.

C'est une bonne nouvelle : le mécanisme de plancher n'est pas à écrire, il est à **brancher**.
Conséquence chiffrée au §2.3.

### ⚠️ Ce qu'elle impose à l'étape « événements bonus », pas encore écrite

L'étape 10 renvoyait à plus tard *« le plancher de rareté des coffres (≥ rare) et des événements
(≥ légendaire) »*. Le premier est fait (étape 11). **Le second ne pourra plus s'écrire tel quel** :
avec la table de cette étape, légendaire n'est plus un multiplicateur mais un pool de trois cartes
exclusives. « Chaque événement donne une légendaire » voudrait dire « toujours l'une des trois »,
répétitif dès le deuxième palier. L'étape des événements devra choisir un autre plancher (épique),
ou un tirage sans remise. Dit ici pour que ce ne soit pas découvert là-bas.

L'exécution se fera dans un worktree, comme les étapes 9 à 12.

## 1. Le livrable en une phrase

**Un étalage tire désormais sur quatre paliers ; les deux plus hauts ne donnent plus des cartes en
plus gros mais des cartes qui changent une règle, et la plus haute se paie.**

Vérifiable ainsi : à graine fixe, un emplacement épique ne sort jamais une carte ordinaire ni une
légendaire ; un porteur de Fournaise voit ses PV max baisser dès le `DRAFT_RESULT` qui lui
donne la carte, sans qu'un octet de plus parte ; un porteur de Transcendance survit à un coup de
contact que ses PV seuls n'encaisseraient pas, et meurt du suivant.

## 2. Les quatre paliers

### 2.0 Les passifs n'ont plus d'emplacements

`PASSIVE_SLOTS` disparaît. `Loadout.addPassive` ne lève plus, `canTake` rend toujours vrai pour un
passif, et `blockedReason` n'a plus de raison pour cette nature. **`WEAPON_SLOTS` ne bouge pas** :
l'arsenal reste à quatre, et c'est lui qui porte le renoncement.

⚠️ **Ce n'est pas un assouplissement cosmétique, ça change ce que le draft EST.** Jusqu'ici un
passif pouvait être refusé ; désormais une carte de passif est **toujours** prenable par tout le
monde. Deux conséquences qui portent loin :

1. **Le conflit devient le seul régime du draft sur les passifs.** Plus aucune case grisée : si
   deux joueurs veulent la même carte, ils se la disputent, ils ne sont jamais bloqués par leur
   propre inventaire.
2. **Le filtre « une carte que personne ne peut prendre ne s'offre plus » de `drawSpread` ne
   retire plus jamais un passif.** Seules les armes peuvent encore en sortir.

⚠️ **Le HUD ne peut plus peindre un nombre fixe de cadres.** `paintPassives` complétait jusqu'à
`PASSIVE_SLOTS` ; il doit maintenant peindre ce qui est possédé, et seulement ça.

### 2.1 Le modèle

```ts
RARITY             = { COMMUNE: 0, RARE: 1, EPIQUE: 2, LEGENDAIRE: 3 }
RARITY_MULTIPLIERS = [1, 2, 1, 1]
RARITY_WEIGHTS     = [72, 20, 6, 2]
```

⚠️ **`RARITY_MULTIPLIERS[2]` et `[3]` valent 1, et ce n'est pas un oubli.** Une carte de règle ne se
multiplie jamais : le triple d'une règle serait du décor — c'est déjà l'argument du §4 de l'étape 10,
la table le dit maintenant elle-même au lieu de le faire dire à un cas particulier.

⚠️ **Renuméroter est sans risque.** `LEGENDAIRE` passe de 2 à 3, mais la rareté ne vit que le temps
d'un `DRAFT_OPEN` : rien ne la persiste. Vérifié dans `back/src/accounts.ts` — le compte ne garde
qu'un solde d'or et des achats indexés **par chaîne d'article**, jamais un identifiant de carte ni
de passif.

### 2.2 Ce que `isLegendaryOnly` devient : rien

`applicationsOf` perd son cas particulier et redevient `multiplierOf(card.rarity)`. `isLegendaryOnly`
disparaît avec lui. Le remplaçant est une donnée, pas une fonction :

```ts
interface Passive {
  // …
  /** Le palier qui lui est RÉSERVÉ. Absent : carte ordinaire. Remplace `legendary?: boolean`. */
  tier?: 'epique' | 'legendaire';
}
```

Le filtre de `drawSpread` se généralise d'autant : **le palier de la carte doit être celui de
l'emplacement.** Un emplacement commun ou rare ne permet que les cartes sans `tier` ; un
emplacement épique, que les `tier: 'epique'` ; un légendaire, que les `tier: 'legendaire'`.

Conséquence assumée : **une carte d'arme plafonne à rare ×2.** Elle ne peut plus sortir en
légendaire ×3. C'est le prix de la frontière nette, et c'était précisément le « tiède » reproché.

### 2.3 Le tirage, et le trou qui devient atteignable

`drawSpread` garde l'ordre de l'étape 10 — **rareté d'abord, carte ensuite, aspect en dernier**,
tout du même `rng`.

⚠️ **Le `break` de sortie du §2.3 de l'étape 10 cesse d'être inatteignable, et c'est le risque
principal de cette étape.** Son commentaire actuel dit lui-même : *« INATTEIGNABLE aujourd'hui, et
aucun test ne la garde »*. Avec un filtre strict par palier, le cas devient courant — et la levée
de la limite de passifs (§2.0) en **déplace la cause sans la supprimer** :

- *Cause écartée par le §2.0* : « les emplacements de passifs sont pleins ». Un passif étant
  désormais toujours prenable, ce cas-là n'arrive plus.
- *Cause réelle, et plus probable qu'elle n'en a l'air* : **l'épuisement du pool dans un même
  étalage.** `drawSpread` tire **sans remise** (`pool.splice`) ; il n'y a que **trois** épiques et
  **trois** légendaires. Un étalage de quatre joueurs compte `4 + SPREAD_BONUS` cartes : dès qu'un
  quatrième emplacement tire épique, le pool épique est vide.

Dans les deux cas l'effet est le même : la boucle sortirait et **l'étalage aurait moins de cartes
que `joueurs + SPREAD_BONUS`**, c'est-à-dire moins de cartes que de joueurs.

Règle de remplacement, à tester : **un palier sans carte prenable redescend d'un cran**, jusqu'au
plancher de l'emplacement (`floor`, étape 11) et jamais en dessous. Si même le plancher n'a aucune
carte prenable, alors seulement la boucle s'arrête — et ce cas-là reste honnêtement inatteignable,
puisqu'un passif est toujours prenable depuis le §2.0.

⚠️ **Conséquence à assumer sur la fréquence affichée** : un étalage ne peut pas montrer plus de
trois épiques ni plus de trois légendaires à la fois, et au-delà les emplacements redescendent. Les
6 % et 2 % du §2.1 sont donc des poids de TIRAGE, pas des fréquences observées sur un grand
étalage. À mesurer au bilan.

⚠️ **Effet de bord sur le coffre de l'étape 11, à annoncer.** `CHEST_RARITY_FLOOR = RARITY.RARE`
renormalise sur `{20, 6, 2}` : un coffre donnera **71 % rare, 21 % épique, 7 % légendaire**. Il
rendra donc une carte de règle presque une fois sur trois. C'est souhaitable — un coffre est un
événement — mais ce n'est pas ce que l'étape 11 a mesuré, et son document de résultats devra le
noter.

### 2.4 Le fil

**Zéro octet.** `rarity` est déjà un `u8` dans `DRAFT_CARD_BYTES` (étape 10) : trois valeurs ou
quatre, c'est le même octet. Le seul coût de fil de cette étape est celui du bouclier (§3.4).

### 2.5 L'écran

`RARITY_NAMES` passe à quatre entrées, `.draft-card[data-rarity="3"]` prend sa bordure, et
`rarityLabel` n'affiche plus de `×N` que pour une rare — les deux paliers hauts valent 1, la table
le dit. Le Guide (`front/src/ui/guide.ts`) suit sans un mot de code : son test affirme déjà que
*chaque* passif du catalogue a une entrée.

## 3. Le malus, et le bouclier

### 3.1 Un malus est un bonus négatif

```ts
interface Passive {
  // …
  /** Ce que la carte COÛTE, dans les genres qui existent déjà. */
  malus?: { kind: PassiveKind; magnitude: number };
}
```

`Loadout.bonus(kind)` retranche `malus.magnitude × exemplaires` quand le genre correspond.

⚠️ **Aucun système neuf, et c'est le point.** Tout ce qui lit `bonus()` — `cooldownWithBonus`,
`shotDamage`, `critOf`, les PV max — voit le malus sans être touché. Et il s'empile comme le reste :
deux exemplaires de Fournaise coûtent 80 PV max, ce qui est la bonne réponse.

⚠️ **Et il traverse déjà le client.** `GameClient#localMaxHp`
(`front/src/net/client.ts:1803`) calcule `PLAYER_MAX_HP + loadout.bonus('maxHp') + achats` depuis le
miroir d'inventaire — la **même somme** que `Room`. Un malus sur `maxHp` descend donc au HUD sans un
octet ni une ligne. (Vérifié en écrivant : le maximum à cliquet qu'on trouve dans ce fichier est
celui du BOSS, `trackBoss`, pas celui du joueur.)

`PASSIVE_KINDS` gagne **`armor`**, pour Hâte funeste (§4). Le genre existait déjà côté boutique
(`BonusKind`) et côté combat (`p.armor`) ; il n'était simplement pas atteignable par une carte.

### 3.2 Une règle n'est pas un malus chiffré

« PV max → 1 » ne peut pas s'écrire `malus: { maxHp, 99 }` : ça doit résister à Vitalité, qui
monterait le plafond par-dessus. D'où un second champ, le même idiome que `Weapon.kind` — un
discriminant nommé dont la branche vit **à un seul endroit par côté** :

```ts
interface Passive { /* … */ rule?: 'transcendance'; }
```

Les deux endroits, un par côté, sont déjà identifiés : la somme des PV max de `Room` côté serveur,
et `GameClient#localMaxHp` côté client. La règle s'y applique en dernier, après les cartes et les
achats — c'est ce qui la rend insensible à Vitalité.

### 3.3 Le bouclier

⚠️ **Avant tout : les quatre formules de dégâts fusionnent.** `Math.max(0, hp − d × (1 − armure))`
est recopiée à quatre endroits — `back/src/room.ts:1711` (tir d'ennemi), `back/src/combat.ts:622`
(kamikaze), `:1737` (contact), `:1856` (charge du boss). Elles deviennent **un** point de passage :

```ts
hurtPlayer(p, degats)   // armure → bouclier → PV, dans cet ordre
```

Ce n'est pas du rangement. **C'est la condition pour qu'un bouclier ne soit pas traversable par une
des quatre sources** — un bouclier correct branché sur trois sur quatre est un bug qu'on découvre au
boss. Et le diff rétrécit : une formule au lieu de quatre.

- **Le débordement tue.** Bouclier 40, coup de 50 : le bouclier tombe à 0, les 10 restants mordent
  les PV. Avec Transcendance (PV max = 1), tout dépassement est mortel.
- **Réserve FIXE**, qui n'échelle pas sur les PV max, plafonnée dans la table — c'est ce qui rend le
  `u8` du §3.4 honnête.
- **Régénération** : `shieldCalmTicks` remis à zéro à chaque dégât ; passé `SHIELD_CALM_TICKS`, le
  bouclier remonte de `SHIELD_REGEN_PER_SEC`. Valeurs de départ proposées au plan, à bouger au
  playtest : réserve **60**, calme **90 ticks** (3 s), régénération **20 /s** (plein en 3 s).
  Repère : le contact coûte `CONTACT_DAMAGE` (8) toutes les 15 ticks, soit 16 PV/s — la réserve
  tient donc moins de quatre secondes dans la horde.

⚠️ **Le gel ne demande aucun cas particulier.** `Room#step` retourne avant tout dégât pendant le gel
(`#tick <= #freezeUntilTick`) et pendant un étalage ouvert (`#draft.phase !== 'closed'`). Si la
régénération vit dans la même portion d'après-gel, elle ne tourne pas non plus : pas de bouclier
rechargé gratuitement à chaque montée de niveau, **sans une ligne pour le dire**.

⚠️ **Vitalité et Regain deviennent inertes chez un porteur de Transcendance**, et c'est le coût, pas
un défaut : Vitalité relève un plafond forcé à 1, Regain soigne des PV plafonnés à 1. Le bouclier
est la seule vie. C'est pour ça que `SHIELD_REGEN_PER_SEC` doit être généreux — et c'est une molette
de playtest, pas une valeur dérivée.

### 3.4 Le fil : +1 octet par joueur et par tick

`SNAPSHOT_PLAYER_BYTES` passe de **10 à 11**, avec un `shield u8` borné à l'encodage comme `bossHp`
l'est déjà. C'est exactement le coût annoncé à l'étape 7b pour le rayon de ramassage, et il est
annoncé ici de la même façon.

Deux variantes moins chères, écartées **explicitement** :

- **`u16`** : +2 o/joueur/tick, le double du précédent record d'étape. Inutile dès lors que la
  réserve est plafonnée (§3.3).
- **Zéro octet**, en réutilisant `hp` : chez un porteur, `maxHp` vaut 1, donc `hp + bouclier` est
  décodable sans ambiguïté (vivant ⇒ `hp = 1`). Ça marche. Et c'est exactement le genre d'astuce
  qu'on déchiffre à 3 h du matin en se demandant pourquoi la barre d'un allié ment. **Un octet
  lisible vaut mieux qu'une inférence juste.**

⚠️ **Pourquoi pas « seulement pour le porteur »** : `encodeSnapshot` construit **un** tampon, poussé
une fois pour tout le salon (`back/src/room.ts:1806`). Un champ réservé au joueur local demanderait
un encodage par client — un coût CPU par tick contre un octet par joueur.

### 3.5 L'écran

Une barre, deux remplissages : le bouclier se peint par-dessus la barre de PV du HUD dans une teinte
propre. Chez un porteur de Transcendance la part PV ne fait qu'un pixel, et c'est juste.

## 4. Le contenu

Règle de sélection, tirée du diagnostic de Léo sur Moisson : **une carte de palier haut ne doit
recouper aucune commune.** Chacune ci-dessous s'accroche à un système que rien d'autre ne touche.

### 4.1 Épiques — une règle, gratuite

| Carte | Effet | Pourquoi elle n'est pas tiède |
|---|---|---|
| **Écho** *(conservé)* | +100 % sur les dégâts instantanés des réactions que vous déclenchez | Seule carte branchée sur les réactions — elle récompense de jouer l'élément, le cœur du projet |
| **Colosse** *(conservé)* | +1 % dégâts par tranche de 10 PV max | Retourne Vitalité en carte offensive : une construction entière, pas un pourcentage |
| **Contagion** *(nouveau)* | Quand un ennemi marqué meurt, sa marque saute sur l'ennemi vivant le plus proche | L'élément se propage dans la horde au lieu de mourir avec sa cible : les réactions s'enchaînent |

Écho et Colosse ne changent que de palier : `legendary: true` devient `tier: 'epique'`. **Contagion
est la seule à coûter du code neuf** — une branche à la résolution des morts, qui relit la
marque et cherche le vivant le plus proche. ⚠️ `shared/chain.ts` n'exporte que `chainTargets` — pas
de recherche de voisin réutilisable telle quelle. Le plan tranchera entre en extraire une et en
écrire une ; c'est le seul vrai coût de code neuf du §4.

### 4.2 Légendaires — une règle énorme, payée

| Carte | Effet | Coût | Nature du coût |
|---|---|---|---|
| **Transcendance** | PV max → 1, bouclier de réserve fixe qui se régénère après un calme | Vitalité et Regain inertes ; tout débordement tue | une **règle** (`rule`) |
| **Fournaise** | +60 % dégâts | −40 PV max | une **statistique** (`malus: { maxHp, 40 }`) |
| **Hâte funeste** | −50 % de recharge | +50 % de dégâts subis | une **statistique** (`malus: { armor, 0.5 }`) |

Les trois sont délibérément de trois natures différentes : la première prouve le chemin « règle », la
deuxième le chemin « malus chiffré » dans sa forme la plus simple, la troisième ouvre `armor` comme
genre de passif — et comme `hurtPlayer` est le point de passage unique (§3.3), une armure négative
mord les quatre sources d'un coup, sans une ligne de plus.

⚠️ **Tous les chiffres de ces deux tables sont des molettes de playtest**, commentés comme tels dans
la table, jamais des valeurs dérivées.

### 4.3 Ce que l'étape supprime

`Moisson`, `resolveHarvest` (`back/src/combat.ts:1763`), `HARVEST_RADIUS`, le genre `harvest`, leurs
tests, et le cas particulier `isLegendaryOnly`. **Du code en moins, pas en plus.** Renuméroter
`PASSIVES` est sans risque pour la même raison qu'au §2.1 : rien ne persiste un identifiant de
passif.

## 5. Ce qui n'est PAS dans cette étape

- **Aucun malus d'équipe.** Le coût mord le porteur, et lui seul — décision de Léo. Un légendaire
  qui pénalise les alliés ferait du draft une négociation, mais c'est un système arbitré à part.
- **Aucun bouclier achetable en boutique.** Le bouclier n'existe que par Transcendance.
- **Aucune carte d'arme épique ou légendaire.** Les armes plafonnent à rare ×2 (§2.2).
- **`WEAPON_SLOTS` ne bouge pas.** Seuls les passifs perdent leur limite (§2.0).
- **Le plancher des événements** (`≥ légendaire`) reste à écrire, et devra changer de forme (§0).

## 6. Les tests et le livrable

**Le test qui compte n'est pas celui d'`hurtPlayer`, c'est celui qui prouve que les quatre sources y
passent.**

| Ce qu'on garde | Où | Forme |
|---|---|---|
| Les quatre sources traversent le bouclier | `back/src/combat.test.ts`, salon | Un test **par source** : bouclier posé, coup porté, le bouclier a absorbé |
| Ordre armure → bouclier → PV, le débordement tue | `combat.test.ts` | Bouclier 40, coup 50 ⇒ bouclier 0, PV −10 |
| Le palier sans carte prenable **redescend** | `shared/cards.test.ts` | Emplacements de passifs pleins ⇒ l'étalage sort à `joueurs + SPREAD_BONUS` |
| La descente s'arrête au plancher | `shared/cards.test.ts` | Plancher rare ⇒ jamais de commune, même sans épique prenable |
| Exclusivité des paliers | `shared/cards.test.ts` | Graine fixe : aucune ordinaire sur un emplacement épique, et réciproquement |
| Le malus se somme et s'empile | `shared/loadout.test.ts` | `bonus(kind)` rend le net ; deux exemplaires doublent le coût |
| Transcendance résiste à Vitalité et à Regain | `back/src/room.test.ts` | PV max reste 1 ; Regain ne dépasse pas 1 |
| Le bouclier ne régénère pas pendant le gel | `room.test.ts` | Dégât, gel long, mesure |
| Le fil | `shared/protocol.test.ts` | `SNAPSHOT_PLAYER_BYTES === 11`, aller-retour, borne à 255 |
| Le Guide montre les quatre paliers | `front/src/ui/guide.test.ts` | Déjà garanti pour les cartes ; `RARITY_NAMES` à quatre entrées à ajouter |

**Pas de banc.** Rien du bouclier n'est prédit côté client — les PV sont arbitrés serveur seul depuis
l'étape 3, le bouclier suit la même règle. Il n'y a donc aucune mesure à 0,000 px à écrire.

**La section « vérification manuelle » du document de résultats restera ouverte** : la générosité du
bouclier, la fréquence des paliers et le ressenti des trois légendaires sont du jugement de jeu, pas
du test.

## 7. Risques

| Risque | Gravité | Parade |
|---|---|---|
| L'étalage sort avec moins de cartes que de joueurs (§2.3) | **Haute** — casse le draft | La règle de descente, et un test qui la garde. C'est le seul risque qui casse une partie. |
| Conflit de rebase avec `etape-11-porteur` sur `rarity.ts` / `cards.ts` | Moyenne | Rebaser sur 11 **avant** d'écrire la moindre ligne ; le `floor` de 11 est un appui, pas un obstacle |
| Le coffre de l'étape 11 donne une carte de règle 29 % du temps (§2.3) | Faible | Souhaitable, mais à noter dans les résultats de 11 — ce n'est pas ce qu'elle a mesuré |
| Transcendance injouable (trop fragile) ou obligatoire (trop forte) | Moyenne | Deux molettes isolées (`SHIELD_*`), playtest de fin ouvert |
| Le facteur `(1 − armure)` sort de ses bornes : une armure de boutique > 1 soignerait, deux Hâte funeste doublent les dégâts subis | Moyenne | `hurtPlayer` borne le facteur à ≥ 0 — un seul endroit, puisqu'il est le point de passage unique. Le doublement, lui, est voulu : un pacte s'empile |
| +1 o/joueur/tick sur le fil | Faible | Annoncé (§3.4), même coût qu'à l'étape 7b, et les deux variantes moins chères sont écartées par écrit |

## 8. Déviations relevées en écrivant

1. **Le `break` inatteignable de `drawSpread` devient atteignable** (§2.3). Trouvé en lisant, pas en
   jouant. C'est la correction la plus importante du document.
2. **Les quatre copies de la formule de dégâts** (§3.3). Le bouclier n'était pas « un champ à
   ajouter » mais « une fusion à faire d'abord ».
3. **Le gel se gère tout seul** (§3.3) — annoncé comme un cas particulier à écrire, il n'en est pas
   un.
4. **Pas de banc de réplication** (§6). Annoncé à tort comme coûteux en conversation ; rien n'est
   prédit, donc rien à mesurer.
5. **L'étape des événements est contrainte par celle-ci** (§0), découvert en vérifiant la feuille de
   route, pas en concevant.
6. **Fausse alerte levée en auto-revue** : j'ai d'abord cru que le client déduisait les PV max par
   un maximum à cliquet, ce qui aurait rendu tout malus sur `maxHp` invisible et aurait bloqué
   Fournaise. C'est `trackBoss` qui fait ça, pour le BOSS. `localMaxHp` calcule la vraie somme.
   Consigné parce que la lecture rapide est piégeuse à cet endroit.
