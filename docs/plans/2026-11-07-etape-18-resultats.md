# Étape 18 — la reconnexion avec état complet : résultats

**Spec :** [`../specs/2026-11-06-etape-18-reconnexion.md`](../specs/2026-11-06-etape-18-reconnexion.md)
**Plan :** [`2026-11-06-etape-18-reconnexion.md`](2026-11-06-etape-18-reconnexion.md)

Un joueur dont la socket tombe en run garde son slot et son état **60 s** (`RECONNECT_GRACE_MS`),
immobile, hors cibles, hors ramassage, mais vulnérable. Le même compte qui revient sur le même
code reprend sa place et reçoit **un instantané complet** (`RESYNC`, message 31), hors tick ;
les autres voient son socle passer gris (`PRESENCE`, message 32, 3 octets, sur changement).
**Zéro octet de plus par tick.**

⚠️ **Ce document est ouvert.** Le §6 attend la run de l'auteur.

## 1. Le livrable

`back/src/reconnexion.integration.test.ts` — vraies sockets, les dix cas du §7 de la spec,
verts d'un coup à l'écriture (10 / 10) :

1. couper J2 en run → `PRESENCE` absent chez J1, slot conservé ;
2. revenir en moins de 60 s → même slot, `WELCOME` puis `RESYNC` **avant** le `SNAPSHOT` du
   même tick (`SNAPSHOT.tick === RESYNC.tick`), aucun `WAVE_ORDER` ni `DEATHS` daté ≤ T
   après ; horde **identique** à celle de J1 ;
3. le loadout revient entier ;
4. un étalage ouvert est reçu, le jeton posable ;
5. un portail ouvert est reçu, gelé, avec son chrono ;
6. le salon plein de nouveaux pendant la grâce : le slot reste réservé (`ROOM_FULL` au
   cinquième) ;
7. l'or est crédité au compte absent en grâce (`400n`, pas `0n`) ;
8. le même compte qui revient n'hérite pas de la fenêtre de ping du précédent ;
9. revenir après 60 s → joueur neuf ;
10. la run finie pendant la grâce → `ROOM_CLOSED`.

Contre-épreuves faites et annulées (chacune rougit un test) :

| Règle cassée | Échec observé |
| --- | --- |
| `RESYNC` envoyé depuis `onFirst` au lieu de `#broadcast` | `expected 17 to be 16` (le snapshot suivant n'a plus le tick du `RESYNC`) |
| historique des positions omis du `RESYNC` | dérive > 0 px (contre-épreuve de `client.test.ts`) |
| `#graces` hors de `#creditAccounts` | `0n` ≠ `400n` |
| `#freeId` sans réservation du slot | le cinquième reçoit un `WELCOME` |

**Taille mesurée du `RESYNC`** : 14 606 octets pour 600 entités, 0 orbe, 0 zone, 2 joueurs ;
soit 24 octets par entité et ~200 octets fixes. Extrapolé à 1 200 entités : ≈ 29 Kio (la spec
disait 31,3 Kio avec 300 orbes et 40 zones). Une fois par reconnexion.

## 2. Ce qui est livré

Neuf commits, un par tâche du plan :

| Tâche | Commit | Ce qu'il prouve |
| --- | --- | --- |
| 1 fil | `9a5ab8b` | `RESYNC` et `PRESENCE` (numéros uniques, tailles dérivées des constantes, aller-retour strict sur les `f32`, chaque bit de `flags` allume sa seule section, tronqué lève) |
| 2 draft/portail | `2964365` | `Draft.rejoin`/`Portal.rejoin` : attendu, mort, fermé, sans doublon ; `NO_VOTE` |
| 3 l'absent | `4ea9fb2` | immobile, sans tir, hors `aimX`, ne ramasse pas, ne tient pas l'étalage (servi d'office), revenu pose un jeton, compte comme mort pour `RUN_OVER`, vulnérable |
| 4 instantané | `e2e3aca` | `Room.resyncState()` : horde `x/y/vx/vy` + cibles des champs, historique 6 ticks (absent exclu), loadouts reconstruits égaux, orbes, zones vivantes, leurres, étalage (`kind`, gel), événement (`elapsed`) |
| 5 session | `5819d1f` | grâce (slot réservé, expiration, `onEmpty` différé, pas en salle d'attente, pas après `RUN_OVER`), `RESYNC` dans `#broadcast`, `PRESENCE` ×2, crédit des absents, `stop()` efface les minuteurs ; `graceMs: 0` dans les tests qui attendaient un départ immédiat |
| 6 client | `e64bd8d` | **suivi à 0,000 px sur 300 ticks** après `RESYNC` (vague en retard comprise), contre-épreuve sans historique qui dérive ; loadouts, étalage, portail, rampe de reprise, événement, `PRESENCE` ; `Horde.acknowledgeFields` |
| 7 socle gris | `d816157` | `baseStyle` présent / mort / absent |
| 8 rejoindre | `a7b5e5f` | `front/src/net/rejoin.ts` : `sessionStorage` par onglet, six codes définitifs → non, 1006 en run → oui, fenêtre, stockage qui lève ; `main.ts` recharge et rejoint seul |
| 9 livrable | `d089383` | §1 |
| — | `b2c20e8` | `Stage` passe les absents au renderer (la ligne qui manquait pour voir le socle gris en jeu) |

## 3. Le coût sur le fil

- `SNAPSHOT`, `WAVE_ORDER`, `DEATHS` : inchangés. **Zéro octet de plus par tick.**
- `RESYNC` : une fois par entrée en run (rejoignant ou retardataire), 24 octets par entité.
- `PRESENCE` : 3 octets, sur changement.

## 4. Écarts au plan et à la spec

- `ResyncState.history[i]` est `{ ids, x, y }`, sans `count`.
- `freezeUntilTick` part brut (dernier gel fini, même passé) ; le client en dérive la rampe
  `+ LEVEL_RESUME_TICKS`. Une fenêtre ouverte vaut un gel à fin inconnue.
- `#openPortal` exclut les absents des votants (sinon ils tiendraient la fenêtre 20 s) ; l'absent
  reste dans `#pending` du draft (servi d'office), pas dans `#awaited`.
- Client : les entrées d'historique vides du `RESYNC` ne sont pas enregistrées (vide ≠ absent
  pour `delayed`) ; le filtre `hp > 0 && !absent` s'applique à la réception du snapshot.
- Une grâce par compte : un second onglet du même compte déjà en grâce part immédiatement.
- `server.test.ts` passe `graceMs: 0` dans son `beforeEach` (un test attendait un départ immédiat).
- Ajouts pour les tests : `Room.debugDropOrb`, getter `Room.draftKind`.
- `main.ts` : « en run » = (`loading.mapReady` ou HUD visible) **et** bilan caché.
- Tests écrits dans la même passe que le code pour les tâches 1 et 3 à 6 (pas rouge d'abord).
- Les champs au-delà du nombre de présents ne voyagent pas : une mort dans les 3 ticks qui
  suivent une reprise peut laisser une entité sur un champ périmé ≤ 3 ticks. Hors spec, noté.
- La mesure du `RESYNC` est faite à 600 entités (trois vagues posées), pas à 10 min.

## 5. Le portique

À remplir après la phase 2 du 7 novembre (chiffres des alliés, `RESYNC_REQUEST` au retour
d'onglet, grâce au `START`) : lancé seul, voir le bas de ce document.

## 6. Vérification manuelle — ouverte

Les points du §9 de la spec, à jouer à deux :

1. Couper le Wi-Fi 10 s en pleine horde : le socle de l'absent passe gris chez l'autre ; au
   retour, la horde est **la même** (aucun monstre qui saute), le build est là.
2. Fermer l'onglet pendant un étalage, rouvrir l'URL : la carte est encore proposée, le jeton
   posable.
3. Idem pendant un portail : la carte compacte, gelée, avec le bon chrono.
4. Couper pendant un convoi : le chariot et la barre d'événement reprennent au bon endroit.
5. Attendre plus d'une minute : revenir donne un joueur neuf, les autres ont vu le personnage
   disparaître.
6. Solo : couper 20 s, revenir — la run a attendu, la horde immobile puis repart proprement.
7. Le temps entre la coupure et la première image après retour : acceptable ?
8. Onglet mis en arrière-plan plus de 2 s puis ramené : la horde ne saute pas (phase 2).
