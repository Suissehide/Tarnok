# Étape 11 — les élites porteurs de coffre : résultats

**Spec :** [`../specs/2026-10-15-etape-11-porteur.md`](../specs/2026-10-15-etape-11-porteur.md)
**Plan :** [`2026-10-15-etape-11-porteur.md`](2026-10-15-etape-11-porteur.md)

Un porteur de coffre — le voleur, agrandi ×1,6, cerclé d'or, un coffre au-dessus de la tête —
apparaît au plus une fois toutes les 50 vagues, à 1 500 px de l'équipe. Il fuit le joueur le plus
proche à moins de 400 px ; à sa mort, l'équipe ouvre un étalage dont **toutes les cartes sont au
moins rares**. **Zéro octet de plus par tick, aucun message nouveau.**

⚠️ **Ce document est ouvert.** Le §5 attend la run de l'auteur.

## 1. Le livrable

`back/src/porteur.integration.test.ts` — deux vraies sockets, observées à travers le décodage :

1. le porteur arrive par un `WAVE_ORDER` ordinaire (19 octets, archétype du porteur) chez les deux
   clients ;
2. sa mort passe dans `DEATHS`, puis vient l'étalage du coffre : toutes ses cartes sont au moins
   rares ;
3. un niveau dû au même tick est servi **après** le coffre ;
4. la règle du client (« une mort de porteur annonce un coffre ») rejouée sur les messages décodés
   marque le premier étalage comme coffre, le second comme niveau.

Trois contre-épreuves faites et annulées : plancher cassé, niveau servi avant le coffre, dette de
coffre jamais comptée — toutes rougissent le test.

## 2. Ce qui est livré

| Pièce | Où |
| --- | --- |
| l'archétype porteur (id 20, après le troll (le boss)), ses constantes | `shared/archetypes.ts` |
| le plancher de rareté (rare : ≈ 83 % rares, 17 % légendaires) | `shared/rarity.ts`, `drawSpread` |
| la fuite (rayon 400 px, 90 % de la vitesse d'un joueur), non collante | `shared/horde.ts` |
| un porteur par palier, 2ᵉ vague, 50 vagues d'écart, sans tirage de plus | `back/src/wave-director.ts` |
| la mort doit un coffre, servi avant le niveau du même tick | `back/src/room.ts` |
| le client reconnaît le coffre à la mort du porteur, sans octet | `front/src/net/client.ts` |
| titre « Coffre », bandeau « Un porteur de coffre est apparu ! », son | `hud.ts`, `draft.ts`, `audio.ts` |
| le voleur agrandi, l'anneau doré, le coffre dessiné en code | `horde-renderer.ts`, `behavior-renderer.ts` |
| point doré sur la mini-carte, flèche dorée au bord | `minimap.ts`, `ping-renderer.ts` |

## 3. Écarts au plan et à la spec

- **La zone de touche du porteur grandit avec son corps** (×1,6) : `projectiles.ts` multiplie le
  rayon par `bodyScale`. Plus facile à toucher, cohérent avec ce qu'on voit.
- **« Attend derrière un étalage ouvert » ne peut pas arriver** : rien ne meurt pendant un gel. Le
  seul cas réel est un coffre et un niveau dus au même tick — le coffre passe d'abord.
- **Le niveau annoncé avec un coffre est celui d'avant** : un niveau gagné au même tick (l'XP des
  orbes arrive après les morts) faisait jouer le son de montée de niveau sur le coffre. Corrigé à la
  revue de la tâche 5.
- **La preuve de réplication de la fuite a été renforcée deux fois** : le scénario du plan n'avait
  ni mort tardive ni rejeu. Le scénario final tue des ennemis au contact du porteur pendant sa
  fuite, livrés en retard au client : **35,089 px** de dérive du porteur lui-même sans rejeu,
  **0,000 px** avec.
- Fait sur la branche `etape-11-porteur`, `main` étant modifié en direct.
- **Revue finale** : un client qui rejoint pendant qu'un porteur vit reconnaît quand même le
  coffre, à son niveau qui ne monte pas ; un test tautologique retiré.

## 4. Le portique

Lancé seul, sur `etape-11-porteur` :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| tests front | **744 / 744** |
| tests back | **1463 / 1463** |
| lint | 0 erreur, 3 avertissements CSS antérieurs (14 octobre) |

## 5. Vérification manuelle — ouverte

- le porteur se repère-t-il d'un coup d'œil (taille, anneau, coffre), et se distingue-t-il d'un
  voleur ordinaire ?
- le coffre au-dessus de la tête reste-t-il lisible (il est dessiné sous le calque des créatures) ?
- la fuite à 400 px : la plupart des armes portent plus loin (la dague ~600 px, l'arc lourd
  ~1 200 px) — le porteur se fait-il abattre de loin sans jamais fuir ? Réglages :
  `PORTEUR_FLEE_RADIUS`, `PORTEUR_HP_MULTIPLE` ;
- 50 vagues d'écart (~5 min) : assez fréquent pour être une attente, assez rare pour être un
  événement ?
- le bandeau et le son d'apparition : se remarquent-ils en pleine horde ?
