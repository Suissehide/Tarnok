# Passe sur l'entièreté du jeu — interfaces, textures, interactions : résultats

Une passe transversale, hors étape : trois audits en lecture seule (rendu Pixi, interfaces
DOM/CSS, interactions entre joueurs) et une session en navigateur à deux onglets sur les serveurs
de dev. Chaque constat porte sa ligne ; chaque correctif livré porte son test ou sa vérification.

⚠️ **Ce document est ouvert.** Le §5 attend la run de l'auteur.

## 1. Ce que le navigateur a montré

Deux onglets, salon à deux, une run jusqu'à la mort (les deux joueurs immobiles tombent en ~1 min).
Résolution 1728 × 893, soit un canevas 1920 × 1080 à l'échelle 0,83.

| Constat | Où | Gravité |
| --- | --- | --- |
| **Étalage à 5 cartes : la cinquième passe sous l'écran** (y ≈ 952 → coupée à 1080). À 2 joueurs l'étalage fait `joueurs + SPREAD_BONUS` = 5 cartes, à 4 joueurs 7 : **toute partie en coop cache des cartes**. | `front/index.html` `#draft-cards`, `main.css` `.draft-card` | haute |
| Salon, onglet Armes : « Vif-argent » chevauche « Homoncule de mercure » ; les noms longs débordent de leur bouton. | `main.css` `.weapon-family__head`, `.room-weapon` | moyenne |
| Les monstres sont lissés (bilinéaire) à côté d'unités et d'un sol en `nearest`. | `horde-renderer.ts` `load()` | moyenne |
| « ESPACE », l'état de connexion et les lignes de l'aide des combinaisons tombent sous 12 px rendus dès 1366 × 768. | `index.html`, `combos.ts` | moyenne |
| Le bandeau du vote d'extraction recouvre « ÉCHAP — Menu » et mord le quatrième emplacement d'arme. | `index.html` `#portal`, bloc ÉCHAP | moyenne |
| Sous le menu Échap et sous le bilan, le HUD et l'étalage restent atteignables à Tab/Entrée. | `main.ts` `setPaused`, `RUN_OVER` | moyenne |
| Le champ « CODE » n'a aucun indicateur de focus (le `outline: none` de la couche `components` écrase la couche `base`). | `main.css` `.ui-input` | faible |
| Gris ardoise `#9aa1ab` sur parchemin sombre : contraste 2,8 : 1 (traits de classe, abstention du vote). | `main.css` `--color-slate-soft` | faible |
| Échap ne ferme ni Options, ni Guide, ni Boutique ; Ctrl+H / Cmd+H basculent l'aide en plus de l'historique du navigateur. | `main.ts` | faible |
| « Quitter au lobby » (seul « lobby » du jeu), « les carrés se figent » (les unités sont des sprites depuis l'étape 8), apostrophes droites dans `portal.ts`. | libellés | faible |

Tout ce tableau est corrigé (§2), et rejoué en navigateur après correction : l'étalage à cinq
cartes tient sur une ligne chez les deux joueurs, le salon côté Armes ne chevauche plus rien,
Échap ferme les menus. Les écrans Options, Guide, Boutique, le salon côté Classes, le HUD, le
menu de pause et le bilan n'ont rien montré d'autre à cette échelle.

## 2. Ce qui est livré

### Rendu (`front/src/render`)

- **Les joueurs et les arbres passent sous les pings et les chiffres de dégâts**, au-dessus du
  noir : `#depth`/`#ghosts` sont insérés dans `composeWorld` juste après `#darkness`, au lieu
  d'être ajoutés après tous les calques (`stage.ts`). Un tronc ne cache plus un chiffre, et
  les arbres ne sont plus éclairés en pleine nuit. Test : `stage.test.ts` compte 18 enfants.
- **Le corps d'un monstre ne saute plus au demi-tour** : l'ancre en x est le centre du
  *contenu* de la cellule (`bounds`), calculée dans `adoptAtlas`, pas le centre de la cellule
  (`horde-renderer.ts`). Avec `scaleX` négatif, le décalage changeait de signe : ~22 px de saut
  pour un crâne. Test : `horde-renderer.test.ts` attend `(x + w / 2) / cell`.
- **La horde est en `nearest`** comme les unités et le sol (`horde-renderer.ts`).
- **La caméra est arrondie au pixel** (`stage.ts` `#centerOn`) : en `nearest`, une caméra
  fractionnaire fait ramper les contours à chaque image.
- **Le joueur est trié par ses pieds** (`player-renderer.ts`, `feet = 0,4 × image × échelle`),
  comme les arbres : il ne passait derrière un tronc que 46 px trop tôt.
- **Un joueur mort se voit mort** : alpha 0,35, socle à 0,25 (`player-renderer.ts` lit `hp`).
- **Un sprite de comportement recyclé repart à l'échelle 1** (`behavior-renderer.ts`) : la
  bouffée de relève des squelettes héritait de l'échelle d'une explosion (3,4) ou d'un tir (0,7).
- **Le pixel art à échelle entière** (décision de Léo, 6 novembre, second passage) :
  `VERTICAL_SQUASH` passe de 0,82 à **1** (une tuile de 64 px vaut exactement 2 px d'écran par
  texel à DPR 2, 1 à DPR 1 ; plus de rangée perdue une fois sur six) ; `UNIT_SCALE` de 0,6 à
  **0,5** (un texel = un pixel d'écran dense) ; la horde repasse en **`linear`** parce que son
  échelle est dérivée de la hitbox (de 0,28 pour le troll à 0,86 pour le poisson-bombe, mesuré
  sur le manifeste de MinIO) et ne sera jamais entière — le vrai remède est de cuire l'échelle
  dans l'atlas (`tools/build_monster_atlas.py`), un actif à redéposer ; les `img` du canevas
  (icônes de 64 px affichées de 28 à 112 px) passent en lissage, les 9-slices restent crénelés.
  Toutes les constantes restent les seuls boutons : l'écrasement se remet en une ligne.

### Interfaces (`front/index.html`, `main.css`, `ui/`, `main.ts`)

- **Étalage** : plus de retour à la ligne ; à partir de 5 cartes, `zoom` 0,8 / 0,66 / 0,58 (et
  `gap` 20 px à 7) pour tenir sur les 1840 px d'une ligne.
- **Salon** : étiquette d'élément à 18 px (tient dans sa colonne de 160 px), noms d'armes à 16 px,
  nom de joueur à 26 px (« Joueur 4 (vous) » débordait), ruban « JOUEUR » à 220 px, « Copier le
  code » à 260 px, « Confirmer ? » de la boutique à 250 px.
- **HUD** : « ESPACE » et l'état à 18 px, lignes de l'aide à 18 px ; bloc ÉCHAP décalé à 520 px
  du bord et bandeau de vote réduit à 1000 px — ils ne se touchent plus, ni les armes.
- **Voiles** : `inert` sur le HUD et l'étalage sous le menu Échap, sur le HUD, l'étalage et le
  vote sous le bilan.
- **Focus** du champ code visible (`outline-offset: -8px` au lieu de `outline: none`).
- **Contraste** : `--color-slate-soft` passe à `#c0c6ce` (≈ 5,4 : 1).
- **Clavier** : Échap ferme Options, Guide et Boutique par leur bouton « Retour » ; H ignore
  Ctrl, Cmd et Alt.
- **Libellés** : « Quitter la partie », « le monde se fige », apostrophes typographiques dans
  `portal.ts` (et son test) ; `aria-live="polite"` sur les cinq messages d'état qui ne l'avaient
  pas.

### Règles de salon (`back/src`, `shared/protocol.ts`, `front/src/net`)

Quatre constats de l'audit des interactions, tous tracés dans le code et reproduits par un test :

- **Le jeton de draft se retire** : `NO_TOKEN` (255) lisait `#spread[255]` → `undefined` → refus
  silencieux. `Draft.setToken` le traite désormais comme un retrait.
- **Un mort ou un déconnecté ne bloque plus l'étalage** : `Draft.forget` et `Portal.forget`
  depuis `Room.leave` ; l'attente (`tousPoses`) ne porte que sur les vivants, les morts gardent
  leur carte à la résolution. Avant : 20 s de monde gelé à chaque niveau, pour le reste de la
  run, dès qu'un joueur lâchait le clavier après sa mort.
- **Un mort n'est plus un leurre invulnérable** : il ne bouge plus, n'attire plus la horde, ne
  ramasse plus (XP et or d'équipe compris). Côté client, la prédiction suit (`#localSpeed` → 0).
- **Les verbes sont refusés pendant le gel, pendant un étalage et après la fin de run.**
- **Le message d'échec de connexion distingue « introuvable » et « plein »** : `CLOSE_CODES` vit
  désormais dans `shared/protocol.ts` et le front lit le code du `CloseEvent`.

## 3. Ce qui est constaté et laissé ouvert

Le 7 novembre, Léo a demandé de tout traiter (« fais les correctifs 1 à 8 »). État :

1. **Reconnexion** → étape 18, exécutée le 7 novembre ; voir son bilan
   `2026-11-07-etape-18-resultats.md`.
2. **Chiffres de dégâts des alliés** → phase 2 du 7 novembre (les bonus de compte voyagent
   dans `LOBBY`).
3. **Horde après un onglet en arrière-plan** → phase 2 du 7 novembre.
4. **`PICK` en vol au `START`** → phase 2 du 7 novembre.
5. **Focus clavier** → fait (`07b2f94`, `keepFocus` dans `room.ts`, repris par `shop.ts`).
6. **Caméra non bornée** → non fait, volontairement : `terrain-renderer.ts` dessine l'eau sur
   une carte entière autour de chaque bord, on ne voit jamais le vide. Un clamp serait du code
   pour rien.
7. **Détails** → faits : badge de niveau (`b0ad4e3`), bandeaux porteur/événement tus pendant
   l'étalage (`c8ce6a7`), roue de ping à l'échelle de l'interface (`3de4a01`), ombres du mortier
   au sol, secousse hors des flèches de bord, DPR suivi (`5aa4246`), marche du trou de lumière
   lissée (`139aa7b`), chemins d'actifs par `ASSETS_BASE` (`f44eb7c`).
8. **Actifs** → faits : l'échelle des monstres est cuite dans l'atlas (`c6a5fa7`,
   `tools/build_monster_atlas.py`, manifeste `prescaled`, le renderer dessine à 1 en
   `nearest` et avertit si l'outil et `BODY_SCALE` divergent) ; Jersey 15 à des tailles
   multiples de 15 (`9d183ef`), sauf les petits jetons. ⚠️ **L'atlas cuit n'est que local** :
   `assets/tinyswords/derived/monsters.{png,json}` sont à redéposer sur MinIO (voir §6) ; en
   attendant, la production lit l'ancien manifeste et garde l'échelle dérivée, en `linear`.

Restent ouverts, de moindre importance : le bilan « Extraction réussie + 0 » quand le wipe et
le vote « partir » tombent au même tick (`room.ts` `#checkRunOver` puis `#stepPortal`, rare) ;
le seuil d'XP qui compte les morts (**assumé par Léo**, ne pas reproposer) ; un monstre devant un
tronc dessiné derrière (`#horde` est un `ParticleContainer` entier sous `#depth`, non
entrelaçable) ; le nouveau code de salon à chaque partie.

L'étalage à plusieurs a été retravaillé le même jour (`094c116`) : cadre à la couleur du joueur
qui vise, carte soulevée, jeton qui rebondit, cadre qui vibre quand deux jetons se disputent une
carte, bandeau du gagnant (portrait et « Joueur N ») sur chaque carte prise, consomption de bas
en haut avec cendres sur ma carte perdue, révélation tenue 3 s à l'horloge murale.

## 4. Le portique

Lancé seul, après tous les sous-agents :

| | Résultat |
| --- | --- |
| `npm run lint` | 226 fichiers, 0 erreur, 3 avertissements `noDescendingSpecificity` **préexistants** (`main.css` 393 et 443, vérifié sur l'arbre committé) |
| `npm run typecheck` | front et back OK |
| `npm test` front | 46 fichiers, **849 / 849** |
| `npm test` back | 67 fichiers, **1700 / 1700** |

Le premier passage avait **un rouge** : `ping.integration.test.ts` › « un joueur qui revient sur
le même id ne récupère pas la fenêtre du précédent », cassé par le refus d'entrée en cours de
run. Le refus a été retiré (§3, point 1) ; le second passage est vert.

Tests ajoutés par cette passe : `stage.test.ts` (18 enfants), `horde-renderer.test.ts` (ancre
au centre du contenu), `draft.test.ts` (×3 : `NO_TOKEN`, `forget`, vivants seuls),
`room.test.ts` (×3 : mort et parti ne tiennent pas l'étalage, mort immobile), `verbes.test.ts`
(étalage et gel), `client.test.ts` (×2 : prédiction à 0 PV, code du `CloseEvent`).

## 5. Vérification manuelle — ouverte

Les points que les tests ne jugent pas, à regarder en jouant :

1. **Étalage à deux puis à quatre** : les 5 et 7 cartes sur une ligne, lisibles ; le zoom 0,58 à
   sept est-il encore confortable, ou faut-il deux rangées plus courtes ?
2. **Demi-tour des monstres** : plus de saut horizontal ; le corps reste centré sur l'anneau de
   marque.
3. **Échelles entières** : le monde n'est plus écrasé (vue de dessus franche, cercles ronds au
   sol), les unités font 0,5 au lieu de 0,6 — trop petites face aux monstres ? La horde est
   lissée (`linear`) : acceptable, ou faut-il cuire l'échelle dans l'atlas tout de suite ?
4. **Nuit** : les arbres ne sont plus éclairés hors du trou de lumière ; les chiffres passent
   devant les troncs.
5. **Un joueur mort** : ombre à 35 %, immobile, la horde l'ignore, il ne ramasse plus — et
   l'étalage suivant ne l'attend pas.
6. **Vote d'extraction** : bandeau, bloc ÉCHAP et armes séparés.
7. **Salon** : onglet Armes, « Vif-argent » et « Homoncule de mercure » ; « Joueur 4 (vous) ».
8. **Code faux / salon plein** : les deux messages distincts sous le champ CODE.

## 6. Déposer l'atlas cuit sur MinIO

Depuis une machine qui a les clés (`MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`, voir
`tools/fetch-assets.sh`) :

```bash
python3 tools/build_monster_atlas.py
aws s3 cp assets/tinyswords/derived/monsters.png  s3://tiny-swords/derived/monsters.png  --endpoint-url https://s3.qwetle.fr
aws s3 cp assets/tinyswords/derived/monsters.json s3://tiny-swords/derived/monsters.json --endpoint-url https://s3.qwetle.fr
```

Le manifeste porte `"prescaled": true` : dès qu'il est en ligne, le renderer passe en `nearest`
à l'échelle 1 sans redéploiement du front.
