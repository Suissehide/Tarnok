# Tarnok — résultats du banc, étape 1

Livrable de l'étape 1 du §13 de
[`../specs/2026-08-19-coop-survivors-orientation.md`](../specs/2026-08-19-coop-survivors-orientation.md).

**L'étape 1 est une porte**, et voici ce qu'elle dit : **la spec tient telle quelle.** La
cible de 800 à 1 500 entités du §4.1 n'est pas le facteur limitant, et de très loin. On
passe à l'étape 2 sans rouvrir le §4.1 ni le §15.2 — mais avec deux réserves explicites,
au §6 de ce document, qu'il serait malhonnête de passer sous silence.

Reproduire :

```bash
npm run bench -w back          # bancs sim et réseau
npm run dev -w front           # puis ouvrir /bench/render.html
```

---

## 1. Machines

| | Machine A | Machine B |
| --- | --- | --- |
| Processeur | Apple M5 Pro (6 P + 12 E) | **à mesurer** |
| Mémoire | 24 Go | |
| Système | macOS 26.5.2 | |
| Node | v25.9.0 | |
| Navigateur | Chrome (WebGL) | |

> ⚠️ **La machine B n'est pas mesurée, et la cible se règle sur elle.** Le plan demande deux
> machines — celle-ci, et une nettement plus faible (un laptop de quatre ans, ou Chrome
> avec un throttling CPU ×4). La M5 Pro est un très mauvais juge : tout y passe. Les
> extrapolations du §5 donnent la règle de conversion, mais une extrapolation n'est pas une
> mesure. **Cette colonne est à remplir avant l'étape 3.**

---

## 2. Le tableau demandé

| Banc | Grandeur | Résultat (machine A) | Machine B |
| --- | --- | --- | --- |
| Sim | entités à 30 Hz, p95 < 11 ms | **≥ 4 000**, sans atteindre la limite | |
| Sim | cellule de flowfield retenue | **64 px** | |
| Rendu | sprites à 60 fps, `ParticleContainer` | **≥ 6 000**, 0,08 ms/image (CPU) | |
| Rendu | sprites à 60 fps, objets `Sprite` | **≥ 6 000**, 0,49 ms/image (CPU) | |
| Rendu | budget de particules à 60 fps | **≥ 20 000** en plus de 1 500 entités | |
| Réseau | ko/s par joueur, 4 joueurs | **0,47 ko/s** (mesuré, sockets réelles) | |
| Réseau | µs d'encodage par tick | **0,17 µs** (4 entités) à **0,25 µs** (24) | |

---

## 3. Banc de simulation

Carte 6 000 × 6 000, 4 joueurs donc 4 champs, 6 % de cellules murées, 600 pas mesurés après
rodage. Budget visé : **p95 < 11,11 ms**, soit un tiers d'un tick à 30 Hz — les deux autres
tiers restant pour tout ce que l'étape 0 ne fait pas encore.

### 3.1 Combien d'entités ? (cellule 64 px, champs à 10 Hz)

| Entités | pas p95 | dont champs | dont déplacement | verdict |
| --- | --- | --- | --- | --- |
| 250 | 0,84 ms | 0,89 ms | 0,00 ms | OK |
| 500 | 0,85 ms | 0,85 ms | 0,00 ms | OK |
| 1 000 | 0,85 ms | 0,86 ms | 0,00 ms | OK |
| 1 500 | 0,88 ms | 0,89 ms | 0,01 ms | OK |
| 2 500 | 0,84 ms | 0,84 ms | 0,01 ms | OK |
| 4 000 | 0,87 ms | 0,88 ms | 0,02 ms | OK |

**Le résultat est dans la colonne qui ne bouge pas.** De 250 à 4 000 entités, le coût d'un
pas passe de 0,84 à 0,87 ms — soit rien. C'est la propriété que le §4.2 allait chercher :
le flowfield coûte `O(cellules)`, pas `O(ennemis)`. Multiplier la horde par seize ne coûte
rien parce que le travail n'est pas fait par la horde.

Le déplacement de 4 000 entités coûte **0,02 ms**, soit 5 ns par entité : des tableaux
typés parcourus linéairement, sans un objet ni une indirection (§4.4). À ce prix-là, la
limite en entités n'est pas ici.

### 3.2 Quelle cellule, quelle cadence ? (1 500 entités)

| Cellule | Cellules/champ | Recalcul | Une passe de 4 champs | pas p95 |
| --- | --- | --- | --- | --- |
| 32 px | 35 344 | 5 Hz | 3,17 ms | 3,23 ms |
| 32 px | 35 344 | 10 Hz | 3,19 ms | 3,31 ms |
| 32 px | 35 344 | 20 Hz | 3,21 ms | 3,35 ms |
| **64 px** | **8 836** | **5 Hz** | **0,84 ms** | **0,86 ms** |
| **64 px** | **8 836** | **10 Hz** | **0,84 ms** | **0,88 ms** |
| 64 px | 8 836 | 20 Hz | 0,84 ms | 0,89 ms |
| 128 px | 2 209 | 5 Hz | 0,20 ms | 0,22 ms |
| 128 px | 2 209 | 10 Hz | 0,21 ms | 0,23 ms |
| 128 px | 2 209 | 20 Hz | 0,20 ms | 0,23 ms |

Le coût est **strictement linéaire en cellules** : 23 ns par cellule visitée, quelle que
soit la taille de cellule (3,17 ms / 141 376 visites = 22,4 ns ; 0,84 ms / 35 344 = 23,8 ns).

La cadence de recalcul, elle, ne change presque rien au p95 : passer de 5 à 20 Hz coûte
0,03 ms. C'est contre-intuitif et c'est logique — le p95 est dominé par les ticks *qui
recalculent*, et recalculer plus souvent n'en rend aucun plus cher. **Ce qui se paie, c'est
la médiane, pas le p95.** On peut donc se permettre 10 Hz sans arrière-pensée.

**Décision : cellule de 64 px.** 32 px coûte quatre fois plus pour une finesse de
navigation dont rien ne prouve qu'on ait besoin ; 128 px est quatre fois moins cher mais une
cellule de 128 px fait deux fois la taille d'un sprite de 64, et la horde commencerait à se
déplacer par blocs visibles. 64 px est aussi la taille de la grille Tiny Swords (§12.2), ce
qui évite un facteur de conversion partout.

---

## 4. Banc de rendu

Page autonome, Pixi v8, WebGL. Deux précautions qui changent le résultat :

- **On chronomètre des blocs de 30 images, jamais une image isolée.** `performance.now()`
  est volontairement grossi à 100 µs dans un navigateur (mitigation Spectre) hors isolation
  cross-origin. Une première version mesurait image par image et rendait « 0 ou 0,1 ms »
  partout : la mesure ne voulait rien dire.
- **On soustrait une passe sans rendu**, pour séparer le coût des transforms de celui du
  rendu. Sans cette soustraction, on ne saurait pas d'où vient l'écart entre les deux
  modes — or c'est précisément la question du §4.3.

### 4.1 `ParticleContainer` contre objets `Sprite`

| Sprites | Mode | Image complète | dont transforms | dont rendu |
| --- | --- | --- | --- | --- |
| 500 | ParticleContainer | 0,020 ms | 0,007 | 0,013 |
| 1 000 | ParticleContainer | 0,023 ms | 0,013 | 0,010 |
| 1 500 | ParticleContainer | 0,030 ms | 0,017 | 0,013 |
| 3 000 | ParticleContainer | 0,047 ms | 0,027 | 0,020 |
| 6 000 | ParticleContainer | 0,080 ms | 0,053 | 0,027 |
| 500 | objets `Sprite` | 0,043 ms | 0,013 | 0,030 |
| 1 000 | objets `Sprite` | 0,080 ms | 0,027 | 0,053 |
| 1 500 | objets `Sprite` | 0,177 ms | 0,037 | 0,140 |
| 3 000 | objets `Sprite` | 0,367 ms | 0,077 | 0,290 |
| 6 000 | objets `Sprite` | 0,487 ms | 0,150 | 0,337 |

**L'écart est chiffré : ×5,9 à 1 500 sprites, ×6,1 à 6 000.** Sur la seule part de rendu,
l'écart monte à ×12,5 à 6 000. Le §4.3 avait raison sur la nature du coût — il est
JavaScript, par objet — et le `ParticleContainer` est le bon outil.

**Mais les deux modes tiennent le budget de 16,7 ms avec trois ordres de grandeur de
marge.** À 1 500 entités, des objets `Sprite` coûtent 0,18 ms par image. Autrement dit :
sur cette machine, **rien n'oblige à écrire le rendu batché tout de suite.** La décision de
le faire quand même se justifie par la marge sur machine faible et par le fait qu'y revenir
plus tard coûte une réécriture du rendu — pas par ce tableau.

### 4.2 Budget de particules d'effet

Empilées **par-dessus 1 500 entités**, parce que c'est dans ces conditions que le budget
compte.

| Particules d'effet | Image complète | dont transforms | dont rendu | 60 fps ? |
| --- | --- | --- | --- | --- |
| 500 | 0,053 ms | 0,023 | 0,030 | OK |
| 2 000 | 0,060 ms | 0,033 | 0,027 | OK |
| 5 000 | 0,090 ms | 0,057 | 0,033 | OK |
| 10 000 | 0,157 ms | 0,100 | 0,057 | OK |
| 20 000 | 0,300 ms | 0,190 | 0,110 | OK |

Le budget n'a pas été atteint : 20 000 particules coûtent 0,3 ms de CPU. **Ce n'est pas une
autorisation de dépenser sans compter** — voir la réserve du §6.1, qui est précisément sur
ce tableau.

### 4.3 fps réels sur 20 s — **non mesuré**

La page expose le bouton « fps réels, 20 s », mais la mesure n'a pas pu être faite ici :
elle exige un onglet **au premier plan**, et Chrome suspend `requestAnimationFrame` dans un
onglet caché. Vérifié plutôt que supposé — 0 image en 3 secondes, `visibilityState:
"hidden"`.

C'est aussi ce qui a produit un faux bug pendant l'étape 0 : une capture d'écran d'un onglet
en arrière-plan montre une image périmée, qu'on prend pour un défaut de réplication. D'où le
test d'intégration headless `back/src/server.test.ts`, qui ne dépend d'aucun rendu.

**À faire, au premier plan :** ouvrir `/bench/render.html`, cliquer le troisième bouton,
reporter les trois lignes ici.

---

## 5. Banc réseau

### 5.1 Coût d'encodage pur

| Entités répliquées | Octets/snapshot | ko/s par joueur | µs d'encodage (médiane) | (p95) |
| --- | --- | --- | --- | --- |
| 4 (les joueurs) | 26 | 0,51 | 0,17 | 0,42 |
| 14 (+10 élites) | 76 | 1,48 | 0,21 | 0,25 |
| 24 (+20 élites) | 126 | 2,46 | 0,25 | 0,33 |

### 5.2 Salons réels, vraies sockets

| Salons | Joueurs | ko/s par joueur | ko/s total | CPU % (1 cœur) | CPU % par salon |
| --- | --- | --- | --- | --- | --- |
| 1 | 4 | 0,47 | 1,89 | 1,61 | 1,61 |
| 10 | 40 | 0,47 | 18,60 | 3,97 | 0,40 |
| 50 | 200 | 0,47 | 93,52 | 12,18 | 0,24 |

**L'estimation de 5 à 15 ko/s par joueur du §3.3 est très conservatrice** — on mesure
0,47 ko/s. C'était attendu : l'étape 0 ne réplique que quatre positions de joueur. Le
chiffre qui comptera est celui de la ligne « 24 entités » : **2,46 ko/s**, soit encore un
facteur 2 sous la borne basse de l'estimation, avec 20 élites répliquées.

Le coût par salon **décroît** avec le nombre de salons (1,61 % → 0,24 %) : le coût fixe du
process s'amortit. À 0,24 % par salon, un cœur saturerait vers 400 salons — mais serveur et
clients tournent dans le même process, donc ce chiffre **sous-estime** le plafond réel. Il
vaut comme point de comparaison entre versions, pas comme capacité de production.

Ce qu'il faut en retenir vis-à-vis de Riot (~200 parties par machine, §3.2) : **on est dans
le même ordre de grandeur, avec une réplication bien plus légère.** Le plafond de Riot ne
disqualifie pas l'approche.

---

## 6. Ce que ce banc ne dit pas

Deux réserves, et elles comptent plus que les tableaux.

### 6.1 Il ne mesure pas ce qui coûtera vraiment

Le banc de simulation mesure **le flowfield et le déplacement, et rien d'autre**. Il ne
mesure ni la séparation entre entités (empêcher 1 500 ennemis de se superposer), ni les
collisions, ni les dégâts, ni les requêtes de zone d'intérêt. Ce sont ces systèmes-là qui
scalent mal avec N, et **aucun n'existe encore**. La séparation, en particulier, est le
candidat évident au prochain goulot : c'est elle qui pousse vers une grille spatiale.

Le banc de rendu, lui, mesure le **coût CPU de soumission** d'une image. Il ne mesure ni le
remplissage GPU, ni le surdessin — or 20 000 particules qui se recouvrent, c'est exactement
un problème de remplissage. La ligne « 20 000 particules à 0,3 ms » dit que le CPU suit ;
elle ne dit rien du GPU.

**Conclusion honnête : ce banc démontre que l'architecture choisie (flowfield, tableaux
typés, batch, binaire) n'a pas de défaut rédhibitoire. Il ne démontre pas qu'on tiendra
1 500 entités une fois le jeu écrit.** C'est déjà ce qu'on lui demandait — mais il faudra le
rejouer, enrichi, à la fin de l'étape 2 et de l'étape 3.

### 6.2 Il a été mesuré sur la mauvaise machine

Voir le §1. Une M5 Pro ne fait pas un juge. La règle de conversion est simple, puisque tout
est linéaire : le coût du flowfield est de **23 ns par cellule visitée**. Sur une machine
quatre fois plus lente, ce serait ~92 ns, et le budget de 11 ms autoriserait ~120 000
visites, donc ~30 000 cellules par champ à quatre champs.

---

## 7. Décisions

| Question | Réponse | Fondée sur |
| --- | --- | --- |
| Le §4.1 tient-il ? | **Oui.** 4 000 entités passent sans atteindre la limite | §3.1 |
| Taille de cellule (§15.2) | **64 px** | §3.2 |
| Cadence de recalcul | **10 Hz**, sans surcoût mesurable | §3.2 |
| `ParticleContainer` ? | **Oui**, ×6 mesuré — mais par prudence, pas par nécessité | §4.1 |
| Le §3.3 tient-il ? | **Oui, largement.** 0,47 ko/s mesuré contre 5-15 estimés | §5 |
| Étape suivante | **Étape 2**, sans rouvrir le §4.1 ni le §15.2 | §3.5 du plan |

### Taille de carte (§15.2)

C'est le nombre de cellules qui décide, pas la taille de carte : à 64 px et 4 champs, le
budget de 11 ms autorise ~117 000 cellules par champ, soit une carte de **~21 000 px de
côté** sur la machine A, et **~11 000 px** sur une machine quatre fois plus lente.

**Proposition : 10 000 × 10 000 px**, qui tient confortablement sur les deux, laisse la
place à d'autres systèmes dans le tick, et reste très en dessous du plafond de 32 767
qu'impose la quantification des positions en `int16` (§3.6). `MAP_SIZE` reste à 6 000 dans
`shared/constants.ts` jusqu'à ce que l'étape 2 ait de quoi remplir une carte plus grande —
l'agrandir avant d'avoir des vagues à y mettre ne prouverait rien.
