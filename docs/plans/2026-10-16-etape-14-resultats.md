# Étape 14 — les événements bonus : résultats

**Spec :** [`../specs/2026-10-16-etape-14-evenements.md`](../specs/2026-10-16-etape-14-evenements.md)
**Plan :** [`2026-10-16-etape-14-evenements.md`](2026-10-16-etape-14-evenements.md)

Un événement bonus, imposé et tiré au hasard parmi trois — **Les trois sceaux**, **La forge**,
**Le convoi** —, s'allume à la 3ᵉ vague d'un palier, jamais avant 2 minutes de jeu et au moins
40 vagues après le précédent. L'équipe a 60 s, gelées pendant les étalages ; la réussite ouvre un
étalage d'équipe dont **toutes les cartes sont au moins épiques**. Trois messages nouveaux, aucun
octet de plus par tick.

⚠️ **Ce document est ouvert.** Le §5 attend la run de l'auteur.

## 1. Le livrable

`back/src/evenement.integration.test.ts` — deux vraies sockets, observées à travers le décodage :

1. **les sceaux** : même `EVENT_START` chez les deux, des `EVENT_STATE` à 5 Hz, la réussite, puis
   un `LEVEL_UP` + `DRAFT_OPEN` dont toutes les cartes sont au moins épiques, reconnu comme un
   étalage d'événement par la règle du client ;
2. **la forge** : la progression monte tant que le joueur est immobile, une entrée de mouvement la
   suspend sans la remettre à zéro ;
3. **le convoi** : sans escorte et sous cinq ennemis, il est détruit — `EVENT_END` en échec, aucun
   étalage.

Contre-épreuves faites et annulées : plancher épique cassé, immobilité de la forge ignorée,
dégâts du convoi coupés — chacune rougit le test.

## 2. Ce qui est livré

| Pièce | Où |
| --- | --- |
| genres, constantes, plancher épique, un palier vide remonte d'un rang | `shared/evenements.ts`, `shared/rarity.ts`, `drawSpread` |
| `EVENT_START` (5 + 4n o), `EVENT_STATE` (7 o, 5 Hz), `EVENT_END` (2 o) — ids 28/29/30 | `shared/protocol.ts` |
| le directeur marque l'événement, sans tirage de plus (empreinte inchangée) | `back/src/wave-director.ts` |
| placement robuste sur les vraies cartes, règles pures des trois événements | `back/src/evenement.ts` |
| le salon : départ, gel pendant étalage et rampe, 60 s, étalage dû (coffre > événement > niveau) | `back/src/room.ts` |
| les `EVENT_*` partent avant le `LEVEL_UP` de leur étalage | `back/src/server.ts` |
| le miroir client : état, compte à rebours sur `pingClock`, étalage reconnu | `front/src/net/client.ts` |
| bandeau, état au HUD, titre « Événement », son | `hud.ts`, `draft.ts`, `audio.ts` |
| zones dorées, anneau de progression, chariot dessiné en code | `behavior-renderer.ts` |
| flèches dorées vers les objectifs hors champ | `ping-renderer.ts` |

## 3. Écarts au plan et à la spec

- **Numérotée 14, exécutée après la fusion des pactes** (étape 13) : la récompense suit leur modèle
  de rareté — plancher **épique** au lieu de « tout légendaire ».
- **Un palier vide remonte d'un rang** : avec le plancher épique, le tirage des pactes produisait
  un étalage de 3 cartes en solo sur 46 % des graines. Désormais toujours min(N + 3, 6) cartes ;
  les étalages ordinaires ne bougent pas d'un octet (empreinte vérifiée).
- **Le placement des sceaux a été refait deux fois en revue** : près d'un coin, deux sceaux
  pouvaient se tasser jusqu'à être tenus par un seul joueur — jusqu'à 100 % des tirages sur les
  vraies cartes (côtes d'eau). Le salon essaie désormais des centres de plus en plus proches du
  centre de l'île : **0 échec sur 853 376 cas** mesurés sur de vraies cartes.
- **Les octets d'état sont bornés** : une valeur de PV hors bornes ne peut plus se replier en
  « détruit ».
- **Le livrable a corrigé une donnée du plan** : un `waveId` de 990 014 dépassait le stockage
  16 bits de la horde.
- Fait sur la branche `etape-14-evenements`, `main` étant modifié en direct par une autre session.

## 4. Le portique

Lancé seul, sur `etape-14-evenements` :

| | Résultat |
| --- | --- |
| typecheck (front + back) | vert |
| tests front | **807 / 807** |
| tests back | **1623 / 1623** |
| lint | 0 erreur, 3 avertissements CSS antérieurs |

## 5. Vérification manuelle — ouverte

- l'annonce se remarque-t-elle en pleine horde (bandeau, son, flèches) ?
- 60 s : assez pour atteindre un sceau à 800 px et le tenir ? Le convoi (1 500 px) est-il faisable ?
- la forge : la horde qui converge sur le joueur immobile rend-elle l'événement tenable à deux ?
  à un ?
- un étalage tout épique (règles et pactes) : récompense excitante, ou trop de pénalités de pactes ?
- 2 minutes avant le premier, 40 vagues entre deux : le bon rythme ?
- un joueur qui ne choisit rien peut recevoir un pacte d'office (attribution automatique) —
  acceptable ?
