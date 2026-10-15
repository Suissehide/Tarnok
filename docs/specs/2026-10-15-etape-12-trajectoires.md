# Tarnok — étape 12 : les trajectoires

> **Vérification manuelle (§7) laissée OUVERTE** : Léo joue à la fin, pas pendant.

## 1. Pourquoi

Retour de Léo : *« Trop d'armes se ressemblent encore, fais des tirs circulaires, etc. »*

Relevé du catalogue (18 armes) : **11 armes tirent la même chose**, un projectile droit vers le curseur.
Six d'entre elles (Grenade, Canon à arc, Chaudron à poix, Canon à chaux, Glaive de mercure, Missile guidé)
ne diffèrent que par la teinte de leur élément. L'étape donne à dix armes une **forme de tir** qui lui
appartient. La Dague et les Flèches jumelles restent droites : il faut des armes de base lisibles.

Léo a validé les dix propositions telles quelles (« je les veux toutes »).

## 2. Ce qui ne change pas

- **Aucun octet réseau de plus.** Un tir reste entièrement dérivé de l'arme, du tick, du tireur et de sa
  visée quantifiée (`shared/projectiles.ts`, docbloc du module). Les deux nouvelles familles (`onde`,
  `frappe`) suivent la discipline du halo et de l'invocation : le serveur arbitre, le client rejoue un
  miroir cosmétique depuis `#fireOne`.
- La visée ne transporte qu'une DIRECTION. Rien ne « tombe sur le curseur » : ce qui vise un point vise
  le point à **portée de l'arme** dans la direction visée (la portée de toujours, `speed × life / TICK_HZ`,
  `beamRange`).
- Le catalogue reste à 18 armes, et l'ordre (donc les identifiants) ne bouge pas.

## 3. Le modèle

### 3.1 Trois champs d'arme de plus (famille `tir`), tous optionnels dans la déclaration

| Champ | Type | Défaut | Sens |
|---|---|---|---|
| `motion` | `'droit' \| 'orbite' \| 'boomerang' \| 'mortier' \| 'sinus'` | `'droit'` | comment le projectile se déplace |
| `emission` | `'visee' \| 'spirale'` | `'visee'` | d'où part l'angle de la salve |
| `fragments` | entier | `0` | éclats projetés en cercle quand le projectile est consommé |
| `growth` | nombre ≥ 0 | `0` | croissance de l'échelle (`projectileScale`) par seconde de vol |

Tout est **recopié sur le projectile à l'émission** (comme `pierce`, `homing`…), jamais relu dans
`WEAPONS` en vol. `motion` voyage sur un `Uint8Array` (code numérique).

### 3.2 L'ancre : où est le tireur maintenant

`Projectiles.step(dt, onExpire?, horde?, anchor?)` reçoit `anchor: (by: number) => {x, y} | undefined`.
Seules `orbite` et `boomerang` (le retour) la lisent. Sans ancre (tests, bancs anciens), l'orbite tourne
autour de son point d'émission et le boomerang revient à son point de départ. Serveur : la position du
joueur `by`. Client : la position simulée pour le joueur local, celle du dernier snapshot pour les autres
— la même source que `#fireWeapons`.

### 3.3 Toucher plusieurs fois le même ennemi

`orbite` et `boomerang` **ne sont jamais consommés à l'impact** (perforation illimitée). Le `#lastHit`
unique ne suffit plus (le `ponytail:` de `#lastHit` l'annonçait : A → B → A toucherait à chaque tick).
Ces deux mouvements tiennent un anneau des **8 derniers ennemis touchés avec l'âge du projectile au
contact** ; un ennemi de l'anneau n'est pas retouché avant `REHIT_TICKS = 20` ticks d'âge. L'horloge est
l'âge du projectile (pas de tick absolu : `collide` n'en a pas côté client).

### 3.4 Deux familles de plus : `onde` et `frappe`

- **`onde`** — un anneau part du joueur et s'agrandit à `projectileSpeed` px/s jusqu'à `blastRadius`
  (le rayon max ; la carte ZONE l'agrandit, comme pour le halo). À chaque tick, il frappe les ennemis dont
  la distance au centre est dans `(r_précédent, r_courant]` : chacun une fois par onde, sans ensemble à
  tenir. Il **marque le plus proche** de ceux touchés à ce tick (même règle que halo et faisceau : une
  réaction par source, §6.6). Centre figé au point de tir.
- **`frappe`** — pas de projectile. Au tir, le point `P = joueur + visée × portée`. Les
  `projectileCount` ennemis les plus proches de `P` dans `FRAPPE_SEARCH_RADIUS = 160` px deviennent des
  points d'impact (positions figées au tir) ; s'il y en a moins, un impact tombe sur `P` lui-même (un
  seul). Chaque impact frappe **`FRAPPE_DELAY_TICKS = 9`** (0,3 s) plus tard, comme une pulsation de halo
  de rayon `blastRadius` — c'est littéralement un `HaloPulse` différé, la machinerie existe. Le client
  choisit ses cibles sur SA horde : approximation cosmétique, exactement comme la chaîne de Foudre.

La logique pure de ces deux familles vit dans `shared/` (rayon d'une onde à un tick, bande de frappe,
choix des cibles d'une frappe, échéance) et sert aux deux côtés.

## 4. Les dix armes

Les nombres sont un **point de départ** : l'implémenteur les ajuste pour garder les propriétés de
`weapons.test.ts` (teintes et calibres distincts, souffle réservé aux armes lentes à projectile unique,
au moins six cartes de cadence utiles, `MIN_MUZZLE_SPEED`…) et un DPS à un exemplaire dans la même
bande qu'aujourd'hui. Une propriété qui contredit l'intention de l'étape se réécrit en le disant ;
elle ne se supprime pas.

| # | Arme | Forme | Ce qui change |
|---|---|---|---|
| 1 | **Chakram** | `motion: 'orbite'` | 3 lames autour du joueur, rayon `ORBIT_RADIUS = 72` px qui respire de ±10 %, `ORBIT_TURNS_PER_S = 0,9`. Vie = cadence (≈ 2 s), donc une couronne continue. Angle de départ = visée. Atouts : SALVO (une lame de plus), CALIBRE, VENOM, RANGE (durée). |
| 2 | **Roue de lames** | `emission: 'spirale'` | Fini la rafale à 360°. Cadence courte (≈ 4 ticks), 2 bras opposés ; l'angle de base est `bornTick × SPIRAL_RAD_PER_TICK` (≈ 0,35), indépendant de la visée. SALVO ajoute un bras. Dégâts par lame réduits pour le même DPS. |
| 3 | **Glaive de mercure** | `motion: 'boomerang'` | Part dans la visée en ralentissant linéairement jusqu'à l'arrêt à mi-vie, puis revient vers l'ancre à pleine vitesse ; disparaît à moins de 24 px du tireur ou en fin de vie. Touche à l'aller et au retour (§3.3). Plus de souffle. Atouts : SALVO, CALIBRE, RANGE. |
| 4 | **Chaudron à poix** | `motion: 'mortier'` | Ne touche **personne en vol** (`collide` l'ignore) ; explose en fin de course (le souffle de fin de course existe déjà). Le rendu le fait monter en cloche (`MORTAR_APEX_PX = 90`) au-dessus d'une ombre au sol. |
| 5 | **Grenade** | `fragments: 8` | Quand elle est consommée (impact ou fin de course), 8 éclats en couronne : même arme (`weapon.id`), dégâts × `FRAGMENT_DAMAGE_RATIO = 0,35`, échelle × 0,5, vie 8 ticks, ni souffle ni éclats. Émis PAR `Projectiles` lui-même, donc identiques des deux côtés. |
| 6 | **Canon à chaux** | `kind: 'onde'` | Anneau de chaux jusqu'à ≈ 220 px, ≈ 420 px/s. Atout : ZONE. |
| 7 | **Canon à arc** | `kind: 'frappe'` | 3 éclairs différés de 0,3 s, souffle `HEAVY_BLAST_RADIUS`. Atouts : SALVO (un éclair de plus), ZONE, RANGE. |
| 8 | **Missile guidé** | essaim (données) | 5 mini-missiles, ouverture ≈ 1,6 rad, guidage plus fort pour qu'ils se rabattent ; plus de souffle (le souffle reste aux armes à projectile unique). Dégâts par missile divisés. |
| 9 | **Fronde à ricochets** | `motion: 'sinus'` | Décalage latéral `SINUS_AMPLITUDE = 36` px, période `SINUS_PERIOD_TICKS = 12`, autour de sa ligne de vol. Les ricochets restent (la ligne repart de l'impact). |
| 10 | **Arc lourd** | `growth` | Flèche plus lente qui grossit en vol (dessin ET touche, via `#scale`) et traverse : `growth ≈ 1,5`/s, perforation de base ≈ 4. |

`Weapon.look` peut bouger si la forme le demande (le Chakram n'a plus de traînée longue, par exemple),
toujours sous `assertWeaponLooks`.

## 5. Rendu (client)

- **Orbite, boomerang, sinus, croissance, éclats, essaim, spirale** : rien de neuf à dessiner, le calque
  des projectiles lit déjà `x`, `y`, `scaleAt`, `headingAt`. L'orbite et le sinus remettent `vx/vy` à la
  tangente de leur course pour que `headingAt` oriente bien le sprite.
- **Mortier** : le calque des projectiles décale le sprite de `-h` en y avec
  `h = MORTAR_APEX_PX × 4p(1−p)` (`p` = âge / vie), grossit légèrement à l'apogée, et dessine une ombre
  ellipse sombre au point sol. Le point sol est la position simulée : c'est elle qui explose.
- **Onde** : un anneau à la teinte de l'arme, épais au départ et qui s'affine en s'éloignant, un léger
  remplissage dans la bande parcourue, et les ennemis franchis reçoivent flash + chiffre de dégâts
  (miroir cosmétique, comme le rayon).
- **Frappe** : pendant le délai, un cercle d'avertissement qui se resserre au sol ; à l'échéance, un trait
  vertical brisé (éclair) qui tombe du haut de l'écran sur l'impact, puis le flash d'impact existant
  (`hitFlashes`, avec secousse).
- Ondes et frappes partagent **un** calque neuf, attaché au §6.6 sous les projectiles.
- `front/src/ui/draft.ts` (et `guide.ts` à la fusion, voir §8) décrit les deux familles neuves.

## 6. Tests et bancs

- `shared/projectiles.test.ts` : une propriété par mouvement (l'orbite reste à `ORBIT_RADIUS` ±10 % de
  l'ancre et suit l'ancre qui bouge ; le boomerang revient et retouche un ennemi déjà touché à l'aller,
  jamais deux fois en `REHIT_TICKS` ; le mortier ne touche rien en vol et souffle en fin de course ; le
  sinus s'écarte de sa ligne d'au plus l'amplitude ; la croissance élargit la touche ; les éclats partent
  en couronne avec les bons dégâts ; la spirale tourne avec le tick). Le test de dérivation (deux
  instances, mêmes entrées, mêmes projectiles) couvre chaque mouvement.
- `shared/` : la bande d'une onde, le choix des cibles d'une frappe, l'échéance.
- `back/` : `Room` tue avec une onde et avec une frappe différée (et pas avant l'échéance) ; l'ancre est
  bien la position du joueur.
- `front/` : le miroir sème ondes et frappes ; le calque neuf trace ce qu'on lui donne et borne son coût
  par la capacité, pas par la horde.
- **Bancs** (lancés seuls, à la fin) : la spirale, l'essaim et les éclats multiplient les projectiles
  vivants ; `truncatedProjectiles` et le budget de tick doivent tenir aux pires charges actuelles.

## 7. Vérification manuelle — OUVERTE

À juger en jeu, ce que les tests ne voient pas :

1. Chaque arme se reconnaît-elle **sans lire son nom** ? (Le but de l'étape.)
2. Orbite : la couronne se lit-elle comme une protection, pas comme du bruit autour du joueur ?
3. Boomerang : le retour se voit-il ? Le second contact se sent-il ?
4. Mortier : la cloche et l'ombre se lisent-elles au milieu de la horde ?
5. Onde et frappe : l'avertissement de la frappe est-il visible ; l'onde est-elle trop présente ?
6. Spirale et essaim : charge visuelle acceptable à 4 joueurs et piles de cartes ?
7. Équilibre ressenti : une des dix est-elle devenue inutile ou écrasante ?

## 8. Fusion

`main` porte des modifications non committées (`front/src/ui/guide.ts`, `draft.ts`…). `guide.ts` tient
un `Record<WeaponKind, …>` : à la fusion, il lui faudra une entrée pour `onde` et `frappe`, sans quoi le
typecheck tombe.

## 9. Découpage

1. **Projectiles** — `shared/projectiles.ts` (+ types et normalisation des champs §3.1 dans
   `shared/weapons.ts`) : mouvements, ancre, anneau de recontact, éclats, spirale, croissance. Tests.
2. **Catalogue et familles** — `shared/weapons.ts` (les dix armes, `WeaponKind` + `onde`/`frappe`),
   module partagé de l'onde et de la frappe, `weapons.test.ts`.
3. **Serveur** — `back/src/room.ts`, `back/src/combat.ts` : ancre passée à `step`, ondes, frappes
   différées. Tests.
4. **Client** — `front/src/net/client.ts` (ancre, miroirs), calque neuf, mortier dans le calque des
   projectiles, `draft.ts`. Tests.
5. **Portique et bancs** (moi, seul).

3 et 4 se font en parallèle une fois 1 et 2 posés.

## 10. Résultats (16 octobre 2026)

- Portique : lint propre (les 3 avertissements existaient déjà sur `main`), typecheck propre, front
  748/748, back 1 480/1 480.
- **Bug trouvé en route : la visée n'est pas unitaire** (octets ±127). Le faisceau de l'étape 8 traçait
  un trait d'environ 127 fois sa portée, côté serveur comme côté client. Corrigé par `aimPoint`
  (`shared/firing.ts`), utilisé par le faisceau et la frappe des deux côtés, et gardé par un test de
  salon. Ça change l'équilibre du Rayon arcanique, à juger en jeu.
- Chaudron à poix : un mortier ne touche personne en vol, donc il ne marquait plus. Le souffle de fin de
  course marque désormais le plus proche, comme le halo. Effet de bord : une Grenade qui expire sans
  impact marque aussi.
- Bancs, lancés seuls, comparés au même banc sur `c22200e` :
  - `slots` était cassé sur `main` (l'arme de classe de l'étape 8 occupait un slot de plus). Le banc est
    réparé. Arme par arme (4 joueurs, 16 exemplaires, 1 500 ennemis), aucune régression. Sur le pire
    décor (4 armes × 16 exemplaires, 4 000 ennemis), le pas p95 passe d'environ 20,5 ms à 26 ms, avec 9 %
    de projectiles en plus. Ça tient dans les 33 ms du tick, mais la marge rétrécit. La boucle de
    `collide` n'a pas changé ; le surcoût restant n'est pas attribué finement.
  - `elements` et `kills` sont cassés sur `main` aussi (noms d'armes disparus, arme de classe en trop).
    Non réparés ici. Le décor « dague seule » de `kills` est identique avant et après (3,58 morts/s).
