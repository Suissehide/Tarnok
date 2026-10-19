# Étape 15 — la progression : les chiffres qui montent

**Demande de Léo (19 octobre 2026) :** « retravailler les chiffres du jeu : que les PV des
monstres augmentent avec le temps ou le niveau des joueurs, équilibrer les armes au début ainsi
que leur augmentation, de même pour les stats du joueur. L'objectif : un sentiment de
progression, des gros chiffres en fin de partie, et non pas juste plus de monstres qui
apparaissent. » Références : *Risk of Rain 2* et *Swarm* (League of Legends).

Pas de spec séparée : tâche bornée, le design a été validé en conversation. Ce document tient
lieu de spec, de plan et de bilan.

⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur.

## 1. Les décisions

Trois questions posées à Léo, trois réponses :

1. **Le banc d'armes plutôt qu'un réglage à la main** — oui.
2. **La puissance du joueur vient des cartes seules**, pas d'une stat innée par niveau. Le dépôt
   le disait déjà partout (« l'accumulation des cartes fait la puissance », « un trait change une
   règle, jamais un nombre ») ; une stat gratuite par niveau aurait dilué le sens des cartes.
3. **Le niveau d'équipe est l'horloge des monstres**, pas le temps ni le palier. *RoR2* et
   *Swarm* montent au temps ; ici le niveau suit déjà le temps par l'expérience, et la rampe de
   vagues (`waveCountBounds`) l'utilise déjà. Une équipe qui ne monte plus est déjà en train de
   perdre. Si le playtest préfère le temps pur, c'est l'argument de `#scaleMonsterHp` et de
   `bossHp` dans `room.ts` qui change, rien d'autre.

Et une contrainte rappelée par Léo en cours de route : **on ne commence plus forcément avec la
dague** — l'arme de départ se choisit au salon. L'ancre « un coup de dague tue un léger » n'est
donc plus la bonne lecture ; c'est « n'importe quelle arme de départ nettoie la première
minute » qu'il faut mesurer, d'où le banc.

## 2. Ce qui change, et pourquoi

| Avant | Après | Où |
| --- | --- | --- |
| PV des monstres ×1,12 par **palier** (mort de boss), piétaille légère **exemptée** | PV ×1,10 par **niveau** d'équipe (`LEVEL_HP_SCALE`), **tout le monde** monte, boss et porteur compris | `shared/paliers.ts` (`levelHpScale`, `monsterHp`, `bossHp`), `room.ts` |
| `LIGHT_HP` = 5 = dégâts de la dague (piège d'arrondi, d'où l'exemption) | `LIGHT_HP` = 4, strictement sous la dague : trois niveaux de marge avant la première marche sans carte de dégâts | `shared/archetypes.ts` |
| Cartes « dégâts » d'arme **additives** : `1 + 0,25 n` | **Composées** : `1,25^n`. Huit cartes font ×6 au lieu de ×3 | `shared/firing.ts` |
| Réaction 25, brûlures 0,3/tick, verglas 0,2/tick, kamikaze 30 : **fixes** | × `levelHpScale(niveau)` : une réaction tue toujours une brute, à tout niveau. Une règle, pas une stat | `back/src/combat.ts` (`scale`), `room.ts` |
| `hpScale(k)` = montée des PV par palier | Ne sert plus qu'à l'or (`palierGold`) ; le nombre d'ennemis reste au palier (`waveCountScale`) | `shared/paliers.ts` |

Ce qui **ne change pas** : les PV du joueur (100, +20 par Vitalité, +10 par palier de boutique),
le contact (8), les tirs ennemis, les passifs (additifs entre eux, modèle *Risk of Rain*), les
dégâts de base du catalogue — voir §4.

### Ordre de grandeur attendu

Joueur seul, niveau 25, six cartes « dégâts » sur son arme et deux Puissance :

| | Niveau 1 | Niveau 25 |
| --- | --- | --- |
| Troupe | 4 PV | 39 PV |
| Brute | 20 PV | 197 PV |
| Boss (solo) | 1 500 PV | 14 800 PV |
| Dague, un coup | 5 | 5 × 1,2 × 1,25⁶ ≈ 23 |
| Grenade, un coup | 36 | ≈ 165 |
| Réaction (Choc thermique) | 25 | 246 |

Les monstres montent de ×9,8 entre le niveau 1 et le 25 ; un build à six cartes de dégâts fait
×4,6 par coup, et le reste vient de la salve, de la cadence et du critique. L'écart est la
pression voulue : **la run finit par s'arrêter**. La pente 1,10 est **un réglage de playtest** ;
l'ancienne pente de palier (1,12) est la valeur de repli si les paliers hauts paraissent mous.

## 3. Le portique

Six fichiers de test retouchés, deux moitiés nouvelles :

- `shared/paliers.test.ts` : `levelHpScale` vaut 1 au niveau 1 et jamais moins en dessous,
  croît strictement à la pente `LEVEL_HP_SCALE` ; **la piétaille légère monte comme la lourde**
  (la moitié qui distingue cette étape de la 6a : si l'exemption revenait, ce test rougit) ; la
  marche de durabilité n'arrive pas avant le niveau 4 sans carte, et arrive bien au niveau 30 ;
  `bossHp` garde ses trois moitiés (base, croissance, proportionnalité aux joueurs).
- `shared/firing.test.ts` : quatre cartes « dégâts » font `1,25⁴`, pas `1 + 4 × 0,25`, et le
  test prouve d'abord que les deux formules diffèrent.
- `shared/archetypes.test.ts` : `LIGHT_HP` strictement sous la dague, et strictement positif.
- `back/src/room.test.ts` : le test de structure du palier force le niveau à 2 et vérifie que les
  PV d'apparition suivent `monsterHp(archétype, 2)` **et** dépassent la base ; le boss porte
  `bossHp(2, 1)`. Correction de décor : au niveau 2, une escorte de colosse sort aussi en ordre
  d'un seul, le boss se reconnaît désormais par son archétype.
- `back/src/combat.test.ts` : le test du « reste exactement nul » pose la réserve aux dégâts de
  l'arme au lieu de supposer `LIGHT_HP` égal.
- `back/src/wave-director.test.ts`, `back/bench/boss.bench.ts` : la charge d'un palier avance le
  niveau et le palier ensemble (un niveau par palier, la cadence la plus lente d'une équipe qui
  tue ses boss) ; la croissance mesurée est ×4,59 entre le palier 0 et le 10.

Résultats : voir §5.

## 4. Le banc d'armes, et ce qu'il a dit

`back/bench/armes.bench.ts` (`npm run bench:armes -w back`) : un joueur seul, immobile, une
arme, 150 s de jeu, 6 graines de carte. Trois écritures de test isolent l'arme nue : le joueur ne
meurt pas (`debugSetHp`), le niveau reste à 1 (`debugSetLevel`, sinon l'arme qui tue vite
affronte vite des monstres plus gros), chaque carte draftée est reprise (`debugResetLoadout`).
Les ticks de gel sont retirés de la durée. Verdict : la part des armes dont les morts/s tiennent
dans ±25 % de la médiane.

| Arme | morts/s | bande |
| --- | --- | --- |
| Rayon arcanique | 8,98 | au-dessus |
| Canon à chaux | 6,83 | au-dessus |
| Homoncule de mercure | 6,58 | au-dessus |
| Grenade | 6,46 | au-dessus |
| Encensoir de poix | 6,03 | au-dessus |
| Chakram | 5,94 | dans |
| Semoir de chaux | 5,77 | dans |
| Glaive de mercure | 5,33 | dans |
| Roue de lames | 4,89 | dans |
| Lance-flammes | 4,77 | dans (médiane) |
| Dague | 4,49 | dans |
| Arc lourd | 3,59 | dans |
| Fronde à ricochets | 3,57 | sous |
| Bobine Tesla | 2,74 | sous |
| Flèches jumelles | 2,42 | sous |
| Canon à arc | 2,37 | sous (portée fixe, voir plus bas) |
| Canon à mitraille | 2,04 | sous |
| Missile guidé | 1,39 | sous |
| Chaudron à poix | 0,70 | sous (projectile lobé, voir plus bas) |

Bande [3,58 ; 5,96] : 7 armes sur 19 dedans.

**La contre-épreuve qui a changé la conclusion.** Le plan était de régler `damage` pour ramener
chaque arme dans la bande. Avant de le faire, les dégâts des cinq armes sous la bande ont été
**doublés** et le banc relancé :

| Arme | dégâts ×1 | dégâts ×2 |
| --- | --- | --- |
| Flèches jumelles | 2,42 | 2,50 |
| Canon à mitraille | 2,04 | 2,08 |
| Bobine Tesla | 2,74 | 2,64 |
| Fronde à ricochets | 3,57 | 3,91 |
| Missile guidé | 1,39 | 1,40 |

**Les dégâts ne sont pas le levier du début de partie.** Un léger meurt de n'importe quel
projectile du catalogue ; ce qui sépare les armes, c'est le nombre de projectiles qui touchent
quelque chose de vivant par seconde — le même limiteur que l'étape 6a avait nommé (« le
limiteur est la VISÉE »). Les armes de zone (faisceau, onde, halo, souffle) dominent une horde
dense ; les tireurs mono-cible plafonnent à `projectileCount × 30 / cooldownTicks` et n'en
réalisent que la moitié.

**Donc le catalogue n'est pas touché**, et c'est une décision, pas un oubli : un `damage` réglé
au banc n'aurait rien changé au début de partie, et aurait déplacé l'équilibre contre les brutes
et les boss sans mesure. Les leviers qui compteraient sont ceux qui font l'**identité** de chaque
arme, et ce choix revient à Léo :

- **Missile guidé** (1,39) : cinq missiles guidés vers le *même* ennemi le plus proche —
  surtuerie. Le levier est le guidage (`homing: 9`) ou une dispersion des cibles, pas les
  dégâts.
- **Canon à mitraille** (2,04) : huit grains à 90° de dispersion et 8 ticks de vie (147 px) — la
  plupart partent dans le vide. Le levier est la portée ou la dispersion.
- **Flèches jumelles** (2,42) et **Bobine Tesla** (2,74) : deux projectiles par salve, sans
  perforation — le plafond est bas par construction. Le levier est `pierce` ou la salve.
- **Canon à arc** (2,37) et **Chaudron à poix** (0,70) : **à juger en jeu, pas au banc.** Une
  frappe et un projectile lobé tombent à portée fixe ; un joueur immobile ne choisit pas sa
  distance, un joueur qui bouge si. Leurs lignes sont un plancher.

Les cinq armes au-dessus de la bande sont toutes des armes de zone, et le banc les mesure dans
le cas qui les favorise le plus (une horde qui s'accumule autour d'un joueur immortel). Pas de
nerf sans run.

⚠️ **Limites du décor, à garder en tête avant tout réglage** : joueur immobile et immortel,
visée automatique sur le plus proche, niveau figé à 1. Il mesure le **nettoyage** de la première
minute, pas le duel contre un boss ni la survie.

## 5. Mesures

Tout a été lancé **seul**, rien d'autre en vol (règle de l'étape 5c).

| Mesure | main (408307a) | cette branche |
| --- | --- | --- |
| Portique complet | — | **807 front + 1 624 back, tous verts** ; Biome : 0 erreur, 3 avertissements préexistants |
| `niveau2` : un joueur passif atteint le niveau 2 en 100 s, 40 graines | 13 échecs / 40, médiane 33,9 s | **12 échecs / 40**, médiane 34,7 s |
| `kills`, dague seule, 4 joueurs | 3,57 morts/s, rapport 0,66 | **3,60 morts/s**, rapport 0,67 |
| `kills`, arsenal plein | *plantait* (voir ci-dessous) | 4,32 morts/s, rapport 0,78, 0 salve tronquée |
| `boss`, 4 joueurs, niveau 1 | — | duel 59,9 s, mêlée 59,9 s (38,4 à 92,3) : **dans la bande 30-90 s, on garde** |
| `armes` (nouveau) | — | médiane 4,77 morts/s, 7/19 dans la bande |

Lecture : **le début de partie ne bouge pas** (niveau 1, aucune échelle), ce que `niveau2` et
`kills` confirment à la graine près. La montée, elle, n'est mesurable qu'en jeu — §6.

**Réparation annexe.** Le décor « arsenal plein » de `kills.bench.ts` plantait sur
`slots d'armes pleins (4)` depuis que la dague de départ occupe un slot (`Room#join`) : il
donnait `WEAPON_SLOTS` armes en plus. Il en donne `WEAPON_SLOTS - 1`, et son docbloc ne parle
plus d'une « arme neutre hors des slots ».

## 6. Vérification manuelle — ouverte

Ce que les tests ne peuvent pas juger, à regarder en jeu :

1. **La courbe.** Au niveau 10, puis 20 : la horde se sent-elle plus dure *par monstre* (un
   troupe à deux coups, une brute qui tient), ou seulement plus nombreuse ? C'est la question de
   la demande. Si les paliers hauts sont mous : `LEVEL_HP_SCALE` monte vers 1,12. S'ils sont un
   mur avant le niveau 15 : 1,08.
2. **Les gros chiffres.** Les nombres qui montent au-dessus des monstres en fin de run
   (`DamageNumbers`) — sont-ils lisibles à trois ou quatre chiffres, et le ressenti de puissance
   est-il là quand on empile des cartes « dégâts » ?
3. **Les éléments tiennent-ils la distance ?** Une réaction au niveau 20 doit encore emporter une
   brute d'un coup. Si les zones (brûlure, verglas) paraissent inertes tard dans la run, c'est le
   `scale` de `resolveBurn` / `resolveVerglasCollisions` à regarder.
4. **La première marche.** Sans aucune carte de dégâts, le troupe demande deux coups à partir du
   niveau 4 (`LIGHT_HP` 4 × 1,1³ > 5). Se sent-elle comme une pression ou comme une injustice ?
5. **Les armes de départ.** Jouer une run avec chacune des armes sous la bande (Missile guidé,
   Canon à mitraille, Flèches jumelles, Bobine Tesla) et une au-dessus (Rayon arcanique) : le
   banc dit-il vrai sur un joueur qui bouge ? Et le Canon à arc, le Chaudron : la portée fixe
   est-elle jouable ?
6. **Le boss.** Sa réserve suit maintenant le niveau, pas le palier : un boss de palier 0 chez
   une équipe déjà niveau 6 porte ×1,6. Le premier boss est-il encore un combat de 30 à 90 s ?
