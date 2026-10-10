# Étape 7a — l'or survit : résultats

**26 commits, 1 585 tests** (1 103 back, 482 front) — **+49** depuis avant l'étape (1 536 :
1 064 back, 472 front). Le livrable tient : une extraction crédite le compte, et une seconde
connexion avec le même jeton, sur une **vraie** socket et une **vraie** Postgres, voit le
nouveau solde.

Le plan comptait neuf tâches ; une a été fondue dans une autre à l'exécution (voir §4), il en
reste huit plus celle-ci. Mais l'histoire intéressante de cette étape n'est pas qu'elle a livré
— c'est **ce que la relecture y a trouvé** : neuf défauts du plan lui-même, quatre défauts
Critiques sur une seule tâche dont trois nés d'un code que j'avais écrit sans l'exécuter, quatre
assertions creuses, huit commentaires faux, et un dernier défaut — trouvé par le portique
final — qui était resté invisible pendant toute l'étape parce que ma propre discipline le
masquait.

**Spec :** [`../specs/2026-10-10-etape-7a-or-persistant.md`](../specs/2026-10-10-etape-7a-or-persistant.md)
**Plan :** [`2026-10-10-etape-7a-or-persistant.md`](2026-10-10-etape-7a-or-persistant.md)

⚠️ **Ce document est ouvert.** Le §10 attend la run de l'auteur.

## 1. Le livrable, et ce qui le distingue des autres preuves de l'étape

« L'or survit à la fermeture du navigateur » — c'est la phrase entière, et rien de plus : la
boutique et les déblocages sont l'étape 7b.

Trois tâches prouvent trois choses différentes, et la distinction est le cœur du livrable :

- la **tâche 5** prouve que la poignée de main marche — un `HELLO` valide ouvre un slot, un
  `HELLO` absent, tronqué ou dupliqué ne tue ni la socket des autres ni le process ;
- la **tâche 6** prouve que **le serveur écrit** — une extraction crédite réellement les comptes
  connectés, pour la cagnotte entière, par un incrément atomique ;
- la **tâche 8** prouve que **l'or survit** — qu'un client qui **revient**, après que sa socket
  s'est **réellement fermée**, lit le nouveau solde depuis une **seconde** connexion. C'est la
  seule des trois qui ferme la boucle : sans elle, la tâche 6 aurait pu passer avec un solde qui
  ne vit que dans la mémoire du process, et personne ne l'aurait su avant la première vraie
  coupure.

La revue de la tâche 8 a vérifié ça dans le code, pas dans le rapport : `goldOf()` fait un
`findUnique` Prisma à **chaque** appel, aucune structure de cache en mémoire n'existe côté
serveur, et la fermeture attendue par le test est un vrai événement réseau (`room.playerCount`
retombant à 0 par le handler `'close'`). Aucun chemin ne peut rendre le test vert sans relire la
base.

## 2. Les décisions de conception, et leur raison

- **La totalité de la cagnotte, à chaque compte connecté** (pas une part égale, pas un abandon).
  Diviser par le nombre de joueurs ferait toucher à chacun moins qu'en solo sur la part de
  palier, ce qui punirait le regroupement au lieu de le rendre rentable (§4.1 de la spec).
- **Un `BigInt`, parce que c'est un calcul et non une précaution.** `GOLD_MAX = 0xffff_ffff`
  dépasse déjà le plafond d'un `Int` PostgreSQL (2 147 483 647) dès la **première** run au
  plafond — pas « à terme ». Et `BigInt` ne se sérialise pas en JSON nativement : la route de
  lecture le convertit explicitement, et un test dédié (tâche 4) pousse un montant au-delà de
  `2^53` pour que la perte de précision soit vraiment exercée, pas seulement nommée.
- **Une vraie Postgres partout, aucun dépôt en mémoire.** Deux implémentations du même contrat
  — l'une en mémoire, l'autre réelle — sont exactement la famille de bug qui a le plus coûté aux
  étapes 5b et 5c. Isolation par **schéma Postgres par worker Vitest**, prouvée (3 fichiers en
  parallèle → `test_0`/`test_1`/`test_2`, chacun avec sa propre table `Account` et sa propre
  `_prisma_migrations`).
- **Le jeton jamais dans une URL.** En en-tête `Authorization` sur HTTP ; comme **premier message
  binaire** de la socket (`HELLO`, largeur fixe de 33 octets) sur le WebSocket, parce que le
  navigateur interdit les en-têtes personnalisés sur une connexion WS et qu'une URL finit dans
  des journaux d'accès.
- **Le crédit vit au drain de `RUN_OVER` par `Session`, jamais dans `Room#endRun`.** C'est une
  correction que la spec elle-même porte (§4.3) : `Room` est de la logique de jeu sans I/O, et y
  glisser un appel Prisma aurait mélangé simulation et persistance.

## 3. Les chiffres

Le portique complet a été lancé **seul**, par le coordinateur, **sans `DATABASE_URL`** — la
condition exacte qui échouait avant le dernier correctif (§8) :

| | Fichiers | Tests |
| --- | --- | --- |
| front | 18 | 482 |
| back | 42 | 1 103 |
| **Total** | **60** | **1 585** |

Avant l'étape : **1 536** tests (472 front + 1 064 back). Soit **+49**.
Durée du back : **299 s**. La ligne de repli de `DATABASE_URL` s'imprime **une seule fois**.
**26 commits** sur l'étape.

## 4. Neuf défauts du plan, trouvés à l'exécution (rulings P1 à P9)

| Ruling | Défaut | Coût s'il était resté faux |
| --- | --- | --- |
| P1 | Le plan faisait écrire `TOKEN_LENGTH` à une tâche pour le faire **supprimer** par la suivante — du travail fabriqué, une duplication créée exprès pour être retirée. La tâche 3 est fondue dans la tâche 2. | Aucun — seule la churn disparaît, le plan passe de neuf à huit tâches. |
| P2 | `Session#accountIdOf` aurait été du **code mort** dès l'écriture : aucun consommateur. Retiré des livrables de la tâche 5 avant exécution (confirmé mort plus tard, à la tâche 6). | Trois lignes à rajouter si un besoin était apparu. |
| P3 | Le plan disait « reprendre les helpers » du harnais de crédit pour la tâche 8, ce qui se lisait des deux façons (importer ou dupliquer). Vérifié : aucun fichier d'intégration du dépôt n'en importe un autre — chacun duplique. Tranché : duplication. | De la duplication qu'un relecteur final pourra proposer de factoriser. |
| P4 | Les briefs des tâches 4 et 5 importaient `type App` depuis `server.ts` — **un type qui n'existe pas**. La convention du dépôt est un alias local `Awaited<ReturnType<typeof buildServer>>`, vérifiée dans les quatre harnais existants. | Un typecheck rouge immédiat ; détection triviale. |
| P5 | Le plan annonçait « les quatre harnais existants » pour le branchement du `HELLO`. `grep` en donne **six** : il manquait `elements-5b.integration.test.ts` (1 030 lignes) et `server.test.ts` (676 lignes) — **5 601 lignes de tests qui marchent** dépendaient de cette poignée de main. | Deux fichiers rouges découverts seulement au portique complet, après plusieurs minutes de run. |
| P6 | Un extrait de brief écrivait `createAccount()` **puis** `once('open', …)` — une **course réelle** : sur localhost, la socket peut s'ouvrir avant la fin de l'aller-retour Prisma, et le listener posé après rate l'événement. A coûté **455 s de blocage** à l'agent qui l'a suivi à la lettre, avant correction (écoute `open` posée avant tout `await`, dans les six harnais). | Nul — le correctif est entré dans le même commit qui l'a révélé. |
| P7 | Deux paires de codes de fermeture **déjà pris** : `CLOSE_ROOM_FULL = 4003 = CLOSE_NO_HELLO`, `CLOSE_UNKNOWN_ROOM = 4004 = CLOSE_UNKNOWN_TOKEN`, les deux paires atteignables sur le **même** chemin de socket. Corrigé en `4005`/`4006`, plus un invariant qui assène les codes deux à deux distincts, construit depuis les constantes et non recopié. | Un client incapable de distinguer « salon inconnu » de « jeton inconnu » — découvert seulement à la tâche 7. |
| P8 | Le test du wipe du brief de la tâche 6 était **creux** : il assénait un montant attendu sur des comptes **neufs**, alors que `WIPE_GOLD_KEPT = 0` rend attendu et état initial identiques — un chemin de crédit entièrement cassé serait passé. Corrigé en pré-approvisionnant les comptes. | Nul — le test devient strictement plus discriminant, sans rien perdre. |
| P9 | Le brief de la tâche 7 laissait un cul-de-sac à un vrai joueur : un jeton **bien formé mais inconnu du serveur** (base réinitialisée en dev) serait gardé pour toujours, la socket se refermant à chaque tentative, sans rien à l'écran. Résolu par le `401` de `GET /accounts/me` déjà appelé au chargement : refus → effacer et re-frapper. | Un joueur de dev bloqué indéfiniment après une base recréée, sans message. |

Deux de ces rulings (P1, P2) auraient laissé du code mort ; un (P4) importait un type inexistant ;
un (P5) oubliait deux fichiers sur six ; un (P6) portait une course réelle ayant coûté 455 s de
blocage ; un (P7) choisissait des codes de fermeture déjà pris.

## 5. La tâche 5 : quatre défauts Critiques, trois nés de mon propre code

La tâche 5 — la réécriture de `Session#add` pour n'attribuer un slot qu'après un `HELLO`
reconnu — est la plus coûteuse de l'étape : trois rondes de correction, et **tous** ses défauts
viennent d'un code que j'avais écrit dans le brief, pas de son exécution.

| Code | Défaut | Mortel pour le process ? |
| --- | --- | --- |
| C1 | `ws.off(onFirstSync)` posé **après** l'`await` : deux `HELLO` arrivant dans la même volée TCP (émis synchroniquement par le même `socketOnData`) attribuaient **deux slots à une seule socket**. C'était littéralement le Review Focus n°2 que mon propre plan nommait. | Non — double comptage des `INPUT`. |
| C2 | Si la socket se fermait **pendant** l'`await findAccountIdByToken`, le slot était attribué quand même : `ws.send` en no-op silencieux, le `'close'` posé après l'émission de l'événement n'était jamais appelé → la `Session` et son timer **fuyaient**. | Non — déni de service trivial par boucle connect/HELLO/close. |
| C3 | J'avais supprimé le `ws.on('error', …)` **synchrone** de l'ancien `add` : il n'existait plus qu'après un `HELLO` réussi. Sur un `EventEmitter` sans listener `'error'`, Node **lève**, et aucun `uncaughtException` n'existe dans `back/src`. | **Oui** — n'importe quelle trame WS malformée avant le `HELLO` tuait le process entier, salons de tous les joueurs compris. |
| C4 | `void onFirst(data)` sans `.catch` sur une promesse qui **rejette** (pool épuisé, base redémarrée) : `unhandledRejection`, même conséquence que C3. | **Oui** — même issue que C3. |

Trois des quatre (C1, C3, C4) sont nés du code de plan ; C2 est une conséquence de la même
frontière asynchrone que ce code ouvrait sans la garder. Deux (C3, C4) tuaient le process entier
— un listener `'error'` retiré, une promesse flottante sans `.catch`.

La preuve de C3 a été obtenue sans rien casser en production : le relecteur a écrit un **script
hors dépôt** rejouant le chemin avec la version exacte de `ws` du dépôt (8.21.3) — avec listener
`'error'` posé, l'erreur de trame RSV invalide ressort proprement (`close` 1006) ; sans lui,
**exception non attrapée, process mort**. Trois rondes de correction plus tard, une
**cinquième** fois dans l'étape un commentaire mentait sur une garantie que le code n'avait pas
(§7), et un second Important — la `Session` pouvant mourir pendant l'`await`, accueillant le
client dans un salon gelé — a demandé une troisième ronde dédiée plutôt que d'être reporté sur
la tâche suivante, pour ne pas mélanger les régions de revue de `Session#add` et `#broadcast`.

## 6. Les assertions creuses : trois dans mes briefs, une héritée du dépôt

Quatre tests de l'étape étaient creux — asséneraient vrai même si le mécanisme qu'ils prétendent
garder était cassé ou retiré. Trois viennent de mon propre texte de plan :

- **(tâche 5)** le test du second `HELLO` attendait le `WELCOME` avant d'envoyer le second — à ce
  moment le `off` a déjà eu lieu, donc le test assénait un chemin déjà sûr et restait vert alors
  même que C1 existait. Corrigé pour envoyer les deux `HELLO` dans la même volée, sans rien
  attendre entre eux.
- **(tâche 6)** le test du wipe — voir P8 ci-dessus.
- **(tâche 6)** le test « base injoignable » : ses deux assertions étaient **tautologiques**,
  parce que le helper du harnais lève déjà si `RUN_OVER` n'arrive pas — supprimer le `try/catch`
  entier aurait laissé le test vert. Corrigé par une **vraie** erreur Postgres provoquée
  (débordement de colonne `bigint`), assénée par une sonde sur le journal.

La quatrième n'est pas née de cette étape : à la tâche 7, `FakeSocket` n'avait **pas** de
`static OPEN`, donc `WebSocket.OPEN` valait `undefined` et `#sendInput` ne parlait **jamais** —
même après un vrai `emit('open', …)`. Les 40+ tests préexistants de `client.test.ts`, vivants
depuis l'étape 3, couvraient donc un chemin d'envoi **inerte**, sans que personne ne l'ait vu.
Ce n'est pas une assertion qui ne mord pas, mais un harnais qui empêche le code d'agir — une
forme différente de la même famille, et la seule des quatre héritée du dépôt plutôt que de mes
briefs. Vérifié par le relecteur que la correction ne change le verdict d'aucun des tests
préexistants (ils n'atteignaient jamais la ligne corrigée).

## 7. Huit commentaires faux, dont un copié en perdant son indice

Huit commentaires ou docblocs affirmant une garantie fausse ont été corrigés au fil de l'étape :
deux docblocs de `setup-db.ts`/`vitest.config.ts` affirmant une migration « une fois par worker »
qui ne l'était pas ; un troisième, introduit par leur propre correctif, prétendant couvrir « les
deux interpolations » d'une requête qui n'en gardait plus qu'une ; un commentaire de `add()`
affirmant le contraire de ce que faisait le code (C1) ; un commentaire affirmant qu'un seul
listener libérait jamais un slot, alors que deux le faisaient (le défaut nommé au §5) ; un
nombre faux dans le docbloc du test de débordement `bigint` (« 500 » alors que le code versait
1000, et qu'avec 500 il n'y aurait eu **aucun** débordement) ; un commentaire de test désignant
comme décisive une assertion qui ne s'exécute même pas quand la mutation mord, risquant de faire
supprimer les assertions qui font réellement le travail.

Le huitième est le seul qui ne vient pas de moi — il vient du dépôt. Un docbloc du livrable de la
tâche 8 attribuait le bonus de palier à `Room#endRun`, alors qu'il est versé dans `Room#step()` à
la mort du boss, et que `#endRun` dit l'inverse dans son propre docbloc. L'erreur avait été
**copiée** : `credit.integration.test.ts` portait déjà une formulation ambiguë mais correcte
(« et `#endRun` verse le bonus de palier au même tick (voir `Room#step`) ») dont la reprise a
perdu la parenthèse — seul indice qui la rendait juste. Les deux ont été corrigés, y compris la
source, pour ne pas laisser le gabarit fautif en place.

## 8. Le dernier défaut : `npm test` était cassé, masqué par ma propre discipline

Le portique complet, lancé seul et sans `DATABASE_URL` — la condition exacte dans laquelle
l'auteur taperait la commande un jour ordinaire — a d'abord donné **42 fichiers en échec, aucun
test exécuté, en 426 ms.** `setup-db.ts` levait si la variable manquait, et `setupFiles` tourne
pour chaque fichier.

En CI c'est invisible (le workflow pose la variable). En local, c'était hostile : un mur de 42
échecs identiques, et le message utile noyé 42 fois. Aucun agent de l'étape ne l'a jamais vu,
pour une raison précise et un peu gênante : **le coordinateur faisait exporter la variable dans
chaque brief.** C'est donc un défaut que ma propre discipline a masqué jusqu'au bout.

Corrigé en faisant retomber `setup-db.ts` sur l'URL locale documentée (celle que la commande
`docker run` du README crée exactement) quand la variable est absente, avec une ligne de journal
disant qu'il a pris le défaut et lequel — pour qu'une Postgres locale différente attaque un échec
franc plutôt qu'une confusion silencieuse. Vérifié : un seul fichier sans la variable passe, deux
fichiers ensemble n'impriment la ligne de repli **qu'une seule fois**.

Un artefact mineur, signalé par transparence et non corrigé : des fichiers de verrou
`tarnok-db-fallback-<ppid>.lock` de taille nulle s'accumulent dans `os.tmpdir()` au fil des runs
sans variable — le mécanisme qui garantit « une seule ligne » entre workers séparés, qui ne
partagent pas de mémoire. Artefact de test dans un répertoire que l'OS nettoie ; noté pour la
revue finale, pas un défaut à corriger.

## 9. Écarts assumés

Repris du §7 de la spec, tels quels :

- **Un jeton perdu est un compte perdu**, sans recours, jusqu'à la promotion e-mail.
- **Un joueur qui rejoint juste avant l'extraction touche tout.** Traité à l'étape 9
  (matchmaking par code, pas encore exploitable tant que les salons se rejoignent entre gens qui
  se connaissent).
- **Pas d'outbox** : trois tentatives bornées puis un journal, récupérable à la main. La sortie
  propre (table d'outbox, rejeu jusqu'à succès) est hors de cette étape.
- **Pas d'historique de runs** : l'étape 7b devra équilibrer sa courbe de prix sans données
  réelles de progression.
- **Aucun classement**, donc l'anti-triche sur l'assistance au jeu reste hors sujet.
- **`POST /accounts` n'a pas de plafond par IP** : la table des comptes est remplissable par une
  boucle. Aucun jeu ne s'y attache aujourd'hui.
- **La CI gagne un service**, donc du temps — l'ordre de grandeur donné par la spec (~1 minute)
  n'a pas été remesuré à l'exécution ; je ne peux pas le confirmer ni l'infirmer ici.

Apparus à l'exécution, et non prévus par la spec :

- **Le front n'est pas branché sur les codes de fermeture du serveur.** La spec attendait que
  `CLOSE_UNKNOWN_TOKEN` déclenche une re-frappe (§2.1 et P7 ci-dessus), mais les codes vivent
  dans `back/src/server.ts` et `front/` ne peut importer que `@shared/*`. Les y déplacer est
  défendable (les codes de fermeture font partie du contrat de fil) mais aurait élargi la tâche
  7. À la place, le `401` de `GET /accounts/me`, déjà appelé au chargement, déclenche la
  re-frappe. Dette nommée : déplacer `CLOSE_CODES` vers `shared/protocol.ts` reste à faire.
- **Aucune échéance de poignée de main.** Une socket qui n'envoie jamais de `HELLO` vit
  indéfiniment — un slowloris gratuit. Différé consciemment : une fois C3 corrigé (§5), elle ne
  coûte plus qu'un descripteur de fichier, plus de crash. Ajouter une échéance demanderait une
  constante, un code de fermeture et ses tests, sur une tâche déjà la plus invasive de l'étape.
- **Le salon plein n'est testé nulle part**, dette préexistante confirmée par grep sur les sept
  harnais de la tâche 5, rendue plus intéressante par le changement de moment de la détection
  (elle se produit désormais après le `HELLO`, pas à l'ouverture de la socket).
- **Pas d'outbox** (déjà dans la spec, confirmé non comblé à l'exécution — voir §4.4 de la spec
  et la tâche 6, dont le test « base injoignable » ne discriminait d'abord rien de réel, corrigé
  en provoquant une vraie erreur Postgres).
- **Des fichiers de verrou dans `os.tmpdir()`** (§8 ci-dessus) : artefact du mécanisme de repli
  sur `DATABASE_URL`, nettoyé par l'OS, pas par le code.

## 10. Vérification manuelle

⚠️ **Section ouverte — attend la run de l'auteur.**

Ce que les tests ne peuvent pas juger, et qu'il faut regarder à la main :

1. **Le solde à l'écran d'accueil** : fermer l'onglet après une extraction, rouvrir, le nombre
   est-il bien là, et bien le montant vu à l'écran pendant la run ?
2. **Une base réinitialisée en dev** (schéma recréé) : le jeton en `localStorage` doit déclencher
   une re-frappe silencieuse via le `401`, pas un blocage — c'est le chemin que P9 a fermé, à
   confirmer dans un vrai navigateur et non seulement par un test injecté.
3. **Le recul du double appel à `GET /accounts/me` au démarrage** : accepté comme négligeable à
   la revue de la tâche 7, à voir si un utilisateur le perçoit (chargement, latence).
4. **La poignée de main sans échéance** (§9) : une socket ouverte sans jamais envoyer de `HELLO`
   — le comportement observé au navigateur (devtools réseau) correspond-il à l'attente, un
   descripteur ouvert sans effet, ou autre chose ?
5. **Le message affiché en cas de panne de base** au moment du crédit : rien dans le front ne le
   montre aujourd'hui (l'écart n'a pas été vérifié à l'écran, seulement côté serveur/journal).

## 11. Questions laissées ouvertes

Reprises et actualisées depuis le §8 de la spec :

- **Quand la promotion en compte e-mail arrive-t-elle ?** Toujours nécessaire dès qu'un joueur
  change d'appareil, toujours pas cette étape.
- **`WIPE_GOLD_KEPT` reste à `0`.** Cette étape rend son réglage gratuit — le chemin de crédit
  passe déjà par le wipe, testé (P8) — mais ne le règle pas : c'est une décision de playtest.
- **Le dev local a maintenant besoin d'une Postgres : résolu.** Le README documente la commande
  `docker run` exacte, le port 5442 (le 5432 étant pris par un autre projet sur la machine de
  l'auteur) et le repli sans `DATABASE_URL`.
- **Le déplacement de `CLOSE_CODES` vers `shared/protocol.ts`** (§9) reste une question ouverte :
  est-ce que le front doit un jour réagir directement aux codes de fermeture plutôt que par le
  détour du `401` ?

## 12. Quatre playtests sont désormais dus

Les documents de résultats de 5b et de 6a ont chacun une section ouverte (5b §4, 6a §3). Celui
de 5c en a une troisième (5c §12). Celui-ci en ajoute un quatrième (§10 ci-dessus). Aucun n'a
encore reçu la run de l'auteur.
