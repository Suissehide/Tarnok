# Étape 19 — le pseudo sur le fil, et « rejouer ensemble » : spec courte et résultats

**Décision :** Léo, 7 novembre 2026 — « Corrige : l'étalage n'affiche que « Joueur N » ; et le
nouveau code de salon à chaque partie ». Une petite étape, spec et bilan dans le même document.

⚠️ **Ce document est ouvert.** Le §5 attend la run de l'auteur.

## 1. Les règles

### Le pseudo

- Un joueur choisit un pseudo **dans le salon**, sur sa propre carte (champ texte, 16 caractères,
  `aria-label` « Votre pseudo »). Il est gardé dans le navigateur (`tarnok.name`) et renvoyé au
  salon juste après le `HELLO`, à chaque connexion.
- Le salon le nettoie (trim, caractères de contrôle retirés, 16 points de code, `cleanName`
  partagé) et le garde **par compte**, pour qu'il survive au lancement et à la grâce de l'étape 18.
- Il voyage dans `LOBBY` (chaque entrée) et dans `RESYNC` (chaque joueur) : un revenant n'a plus
  de `LOBBY`. **Zéro octet de plus par tick.**
- Il s'affiche sur les cartes du salon, sur le bandeau du gagnant à la révélation de l'étalage,
  sur le bilan, et **au-dessus de la tête des alliés** en jeu (8 novembre, jamais au-dessus de
  soi). Sans pseudo : « Joueur N ».

### Rejouer ensemble

- Après `RUN_OVER`, le bilan porte deux boutons : « Rejouer ensemble » et « Menu principal ».
- `REPLAY` (de n'importe quel joueur connecté) remet la session en salle d'attente **sur le même
  code** : un `Room` neuf (graine neuve), les choix d'arme et de classe de chacun reposés, un
  `LOBBY` diffusé. Un second `REPLAY` est ignoré ; un `REPLAY` avant `RUN_OVER` aussi.
- Les clients se rechargent pour repartir propres (`sessionStorage` `tarnok.replay`, lu une fois)
  et rejoignent seuls le code. Pendant `REPLAY_HOLD_MS` (30 s) la session ne se ferme pas à zéro
  client, et un compte connu reprend son slot et ses choix au `HELLO`. Passé le délai sans
  personne, fermeture normale.

## 2. Les messages

| Message | Sens | Octets |
| --- | --- | --- |
| `NAME` (34) | client → salon | `type u8 · len u8 · utf8[len]`, `len` en octets, 64 au plus |
| `REPLAY` (35) | client → salon | 1 |
| `LOBBY` | salon → clients | entrée = `playerId · weaponId · classId · bonus (3) · len · utf8[len]`, taille variable |
| `RESYNC` | salon → client | joueur = `id · classId · flags · nWeapons · bonus (3) · len · utf8[len]`, puis armes et passifs |

Rien par tick.

## 3. Ce qui est livré

| Commit | Contenu | Tests |
| --- | --- | --- |
| `66149f8` | `NAME`, `REPLAY`, le pseudo dans `LOBBY` et `RESYNC`, `cleanName`, `NAME_MAX_CHARS` / `NAME_MAX_BYTES` | `lobby.test` 13 / 13, `protocol.test` 182 / 182 : tailles calculées (« Léo », « Zoé 🐉 »), tronqué au milieu d'un pseudo lève, 64 octets max |
| `bd3558e` | `Session#names` par compte, `NAME` en salle d'attente (rediffusion) et en run (table, `RESYNC` futur) | `lobby.integration` 11 / 11 (nom chez l'autre, tronqué, vide), `server.test` (le `RESYNC` porte le nom, survit à la grâce) |
| `ace5443` | `rename`, `nameOf`, `replay()` ; `loadName` / `saveName` | `client.test` 161 / 161, `settings.test` 8 / 8 |
| `f9aa09d` | le champ sur ma carte du salon (focus et frappe conservés au repeint), le nom sur les autres cartes, le bandeau du gagnant, le bilan | `room.test` 14 / 14, `draft.test` 76 / 76 |
| `fad0749` | `REPLAY` : `Room` neuf sous le même code (`RoomRegistry.replace`), choix reposés, `LOBBY`, fenêtre `REPLAY_HOLD_MS` qui diffère la fermeture, `stop()` efface le minuteur | `server.test` 33 / 33 : même code et mêmes choix, tous partis puis revenus → mêmes slots, avant `RUN_OVER` ignoré, fermeture passé le délai |
| `7b72562`, `485f240` | `writeReplay` / `readReplay`, rechargement et reprise, les deux boutons du bilan | `rejoin.test` 9 / 9, `summary.test` 4 / 4 |
| `fba2598` | une affectation sortie d'une expression (lint) | — |
| `8407c95` | **le pseudo flotte au-dessus des alliés** (`Text` Jersey 15 à la couleur du joueur, calque des fantômes, jamais pour soi) ; les états génériques de bouton passent avant le kit (0 avertissement Biome) | `player-renderer.test` (`nameLabelOf`) |
| `263447c` | **le pseudo part au premier `LOBBY`**, plus collé au `HELLO` : le salon n'écoute une socket qu'une fois le compte résolu, une trame envoyée entre-temps était perdue — mesuré en navigateur (« Joueur 1 » malgré un pseudo gardé) | `client.test` : `HELLO` seul à l'ouverture, `NAME` au premier `LOBBY`, pas au second |

Vérifié en navigateur à deux onglets : le pseudo saisi sur ma carte apparaît chez l'autre, le
bilan le porte, « Rejouer ensemble » ramène les deux onglets dans le salon `BWCG` avec les
mêmes slots, classes, armes et pseudos. (Les deux onglets partagent le même compte : le pseudo
est par compte, donc identique des deux côtés dans cet essai.)

## 4. Le portique

Lancé seul le 8 novembre, après l'étiquette et le correctif du `NAME` : lint **0 erreur,
0 avertissement**, typecheck OK, front 48 fichiers **957 / 957**, back 68 fichiers **1788 / 1788**.

## 5. Vérification manuelle — ouverte

1. Deux comptes différents : chacun son pseudo, visible chez l'autre dans le salon, sur le bandeau
   du gagnant, au bilan.
2. Pseudo avec accents et emoji ; pseudo de 20 caractères (coupé à 16) ; pseudo vide (« Joueur N »).
3. Changer de pseudo pendant la frappe d'un coéquipier : le champ garde le curseur.
4. « Rejouer ensemble » à deux : retour dans le même salon, mêmes choix, et la run suivante a une
   carte différente.
5. L'autre joueur clique « Menu principal » : il part, le salon reste pour celui qui rejoue.
6. Attendre 30 s sans revenir : le code est mort, le message « introuvable » s'affiche.
