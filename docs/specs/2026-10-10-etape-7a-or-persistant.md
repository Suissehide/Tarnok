# Étape 7a — l'or survit à la fermeture du navigateur

**Livrable du §13 :** « l'or survit à la fermeture du navigateur ». C'est la phrase entière, et rien
de plus : la boutique, les améliorations permanentes et les déblocages sont l'étape **7b**.

## 1. Ce que l'étape change au jeu

Aujourd'hui, une équipe qui s'extrait au palier 4 avec 1 200 d'or voit ce nombre disparaître à la
fermeture de l'onglet. L'or existe depuis l'étape 6a, il se gagne, il se risque, il se perd au wipe —
et il ne sert à rien, parce qu'il ne survit pas à la run.

Après cette étape, il survit. Chaque joueur a un **compte**, le serveur en possède le solde, et
l'extraction y verse la cagnotte.

C'est la première fois que le projet écrit quelque chose qui dure plus longtemps qu'un salon en
mémoire. Trois choses apparaissent donc en même temps : une **identité**, une **base de données**, et
un **transfert** entre l'une et l'autre.

### 1.1 Ce qu'elle ne met PAS en danger

Le contrat de réplication (§3.3) n'est pas touché. Rien de ce qui se décide ici n'entre dans la boucle
de jeu :

- le protocole binaire gagne **un** type de message, `HELLO`, envoyé **une fois par connexion**,
  du client vers le serveur, avant l'attribution du slot ;
- **zéro octet de plus par tick.** Le `SNAPSHOT` n'est pas touché, ni `ZONE`, ni `REACTION` ;
- le solde persistant ne passe **jamais** par le fil de jeu : il se lit en HTTP, sur l'écran
  d'accueil.

C'est la conséquence directe de la décision du §5 : le joueur voit son solde **à l'accueil**, pas dans
le HUD. Un solde personnel affiché en permanence pendant la run aurait été le premier ajout d'octets
par tick depuis l'étape 5a.

### 1.2 Ce qu'elle casse sciemment

Le §11 de l'orientation le dit : « l'or persistant **casse la décision d'InkPoint** de ne pas avoir de
comptes ». Cette étape est l'endroit où cette décision se paie.

## 2. L'identité — un compte anonyme, un jeton, aucun formulaire

Décidé au §11, non rouvert ici : **compte anonyme par jeton persistant**, créé sans friction à la
première partie.

1. `POST /accounts` frappe un jeton aléatoire cryptographiquement sûr, le renvoie **une seule fois**,
   et stocke son **sha256** avec un index unique.
2. Le client garde le jeton en `localStorage`.
3. Le serveur ne détient **jamais** le jeton en clair. Un dump de la base ne donne aucun compte.

**Quand.** Le client appelle `POST /accounts` **au premier chargement où `localStorage` ne porte pas
déjà un jeton**, et jamais autrement. C'est le « sans friction » du §11 : aucun écran, aucun
formulaire, aucun clic.

⚠️ **Surface d'abus à nommer :** cette route crée une ligne sans authentification, donc elle est
appelable en boucle. Une ligne coûte quelques dizaines d'octets et aucun jeu ne s'y attache, mais une
boucle la remplirait indéfiniment. Un plafond par IP est le réflexe ; il n'est **pas** dans cette
étape, et il est inscrit au §7 comme écart assumé.

### 2.1 Le jeton ne passe jamais par une URL

Ni en paramètre de requête, ni dans le chemin. Une URL atterrit dans les journaux d'accès du reverse
proxy, dans les en-têtes `Referer` et dans l'historique du navigateur — et ce jeton **est** le compte.

- **En HTTP** : en-tête `Authorization`.
- **Sur le WebSocket** : le navigateur interdit les en-têtes personnalisés sur une connexion
  WebSocket, donc le jeton voyage comme **premier message binaire de la socket** — `MSG.HELLO`,
  avant que le serveur n'attribue un slot.

L'alternative examinée et écartée : un **ticket à usage unique** obtenu en HTTP et passé dans l'URL du
WebSocket. Elle évite d'ajouter un type de message, mais ajoute une route, une durée de vie, un
stockage de tickets — et met quand même un secret dans une URL, même brièvement.

### 2.2 Le jeton est obligatoire, et ce que ça coûte

Une connexion sans `HELLO` valide est **refusée**. Pas de chemin « jouer sans compte ».

Coût assumé : les quatre harnais d'intégration existants (`draft`, `elements`, `portal`,
`elements-5c`, ~2 000 lignes de tests qui marchent) appellent `connect(code)` et attendent un
`WELCOME`. Ils gagnent tous un `HELLO`.

**Pourquoi ne pas rendre le jeton optionnel**, ce qui n'aurait touché aucun test existant : parce que
le chemin « sans compte » n'existerait **que pour les tests**. C'est la sixième forme du « décor qui
masque » recensée à l'étape 5c — un mécanisme que la production n'emprunte jamais, et dont les tests
restent verts. Les étapes 5b et 5c ont payé cette famille de bug cinq fois.

### 2.3 La propriété de sécurité, écrite plutôt que découverte

Sans mot de passe, **le jeton est le compte**. Qui l'a, l'est. Et jusqu'à la promotion en compte
e-mail, **un jeton perdu est un compte perdu, sans recours.**

C'est le prix de l'entrée sans friction que le §11 a choisie, et ce n'est pas un oubli. La promotion en
compte e-mail — que le §11 propose pour « survivre à un changement d'appareil » — est **hors de cette
étape** : le livrable dit « survit à la fermeture du navigateur », et un jeton en `localStorage` plus
un solde côté serveur y suffisent. Changer d'appareil est un autre besoin, qui traîne de
l'authentification et de l'envoi d'e-mails avec lui.

## 3. La base — la première du projet

Le §12 a tranché la pile : **Prisma + PostgreSQL**. `deploy/compose.yaml` déclare déjà une
`postgres:16-alpine` avec `DATABASE_URL`, un healthcheck et un volume persistant, et
`deploy/.env.example` porte ses variables. Le côté déploiement a été préparé à l'étape 0 ; il ne
manque que l'applicatif.

### 3.1 Le schéma, une table

```prisma
model Account {
  id        String   @id @default(uuid())
  tokenHash String   @unique
  gold      BigInt   @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Pas de table de runs. C'est la décision du §5 : le joueur voit un solde, pas un historique.

### 3.2 `BigInt`, et c'est un calcul, pas une précaution

`GOLD_MAX = 0xffff_ffff = 4 294 967 295` — le plein `u32`, la borne du fil posée à l'étape 6a. Le
maximum d'un `Int` PostgreSQL est **2 147 483 647**.

Une colonne `Int` déborderait donc **dès la première run au plafond**, pas « à terme » : par
construction. Un `BigInt` tient 2 147 483 648 runs au plafond.

⚠️ **Conséquence réelle à ne pas découvrir à l'exécution :** Prisma mappe `BigInt` sur le `bigint` de
JavaScript, qui **ne se sérialise pas en JSON** nativement. La route de lecture doit le convertir
explicitement.

### 3.3 Comment ça se teste — une vraie Postgres, partout

Une seule implémentation : celle de production. **Aucun dépôt en mémoire.**

- La CI gagne un bloc `services` avec `postgres:16-alpine` — **la même image** que
  `deploy/compose.yaml`, pour qu'aucune dérive entre test et production ne soit possible.
- `prisma migrate deploy` avant les tests.
- Isolation : **un schéma PostgreSQL par worker Vitest** (`?schema=test_<worker>` dans
  `DATABASE_URL`), donc les fichiers continuent de tourner en parallèle sans se piétiner.

**Les deux alternatives, examinées et écartées.**

| Approche | Pourquoi non |
| --- | --- |
| Dépôt en mémoire pour le gros des tests, Postgres réelle pour quelques intégrations | **Deux implémentations du même contrat.** Un store en mémoire qui n'applique pas une contrainte d'unicité, ou qui ne voit pas une transaction, est exactement la famille de bug qui a coûté le plus cher aux étapes 5b et 5c — et elle entrerait dans la première base du projet |
| SQLite pour les tests, Postgres en production | Le provider Prisma se déclare **dans le schéma** : deux bases veut dire deux schémas. Et une requête ou une migration valide en SQLite peut casser en Postgres — c'est la première forme du « décor qui masque », le décor de test qui diffère de la production juste assez pour verdir pour la mauvaise raison |

La culture du dépôt tranche d'elle-même : les livrables du draft et des éléments tournent sur
**quatre vraies sockets**, pas sur des sockets simulées. Une vraie base est le même choix.

## 4. Le crédit — qui, combien, comment

### 4.1 Combien : la totalité de la cagnotte, à chacun

Une extraction à 1 200 d'or à quatre joueurs crédite **1 200 à chacun des quatre comptes**.

**1 200 est le montant APRÈS le multiplicateur d'extraction**, c'est-à-dire la valeur que
`extractGold(gold, multiplier)` rend et que `PORTAL_RESULT` annonce déjà au client. Le compte reçoit
exactement le nombre que le joueur a vu à l'écran — pas la cagnotte brute d'avant majoration. Un écart
entre les deux serait invisible au test et visible au joueur.

**Pourquoi pas une part égale** (1 200 ÷ 4 = 300). La part de palier
(`GOLD_PER_PALIER_BASE × hpScale(k)`) ne dépend **pas** du nombre de joueurs ; seules les pièces
ramassées passent à l'échelle, parce qu'à quatre on tue plus. Diviser la cagnotte par N ferait donc
toucher à chacun **moins** qu'en solo sur la part de palier. Le §8.1 est explicite : « le jeu doit
rendre le regroupement **rentable**, jamais **obligatoire** », et « une punition se lit comme un bug ;
une incitation se lit comme du design ».

**Pourquoi pas non plus la totalité avec `palierGold` multiplié par N** : ça ferait avancer la méta
beaucoup plus vite à quatre qu'en solo, et l'étape 7b devrait équilibrer sa courbe de prix sur une
progression qui dépend du nombre de joueurs.

### 4.2 Qui : les joueurs connectés au tick de FIN DE RUN

- Un joueur **mort mais connecté** — la forme fantôme du §8.2 — **est** crédité. Le §8.2 insiste pour
  que le mort reste de l'équipe ; l'or suit cette règle.
- Un joueur **déconnecté avant le vote** ne l'est pas : le serveur n'a plus de socket d'où lire son
  compte.

⚠️ **« Fin de run », pas « extraction » — et la nuance compte.** Le §4.3 fait passer le wipe par le
**même** chemin que l'extraction. La règle est donc celle du tick où `#endRun` s'exécute, quelle que
soit la porte empruntée. Écrire « au tick d'extraction » aurait laissé le wipe sans règle le jour où
`WIPE_GOLD_KEPT` cesse de valoir `0`.

⚠️ **Propriété connue, écrite ici plutôt que découverte plus tard :** quelqu'un qui rejoint un salon au
palier 9 juste avant l'extraction touche la totalité sans avoir joué. Les salons se rejoignent **par
code**, entre gens qui se connaissent, jusqu'à l'étape 9. C'est le matchmaking qui rend ça
exploitable, et c'est donc à l'étape 9 que ça se traite.

### 4.3 Comment : un incrément atomique, un seul chemin

**Un `UPDATE … SET gold = gold + N` par compte.** Un incrément atomique, jamais un
lire-modifier-écrire : le même jeton peut être ouvert dans deux onglets, donc dans deux salons. Un
incrément est juste sous concurrence ; une relecture suivie d'une écriture ne l'est pas.

**Le crédit vit dans `#endRun`**, et c'est le seul endroit. `Room#endRun` est déjà documenté comme
« LE seul endroit qui termine une run », avec **deux** chemins pour y arriver — l'équipe effacée et
l'équipe qui part par le portail — et ses docblocks établissent qu'un second appel est
**inatteignable**, le garde de tête de `step()` le rendant impossible.

**L'idempotence du crédit est donc héritée d'un invariant déjà prouvé**, et ne demande ni table de
journal ni clé d'idempotence.

Conséquence voulue : l'extraction **et** le wipe passent par le même chemin. Le wipe crédite
`gold × WIPE_GOLD_KEPT`, qui vaut `0` aujourd'hui. Faire passer cette constante à `0.15` — ce que son
propre docblock désigne comme **le** paramètre de playtest du §9.3 — ne demandera **aucune plomberie
neuve**. C'est exactement ce que ce docblock exige déjà : « la perte passe par une seule ligne ».

### 4.4 Le mode de panne, nommé et borné

Si la base est injoignable au moment du crédit : **trois tentatives bornées**, puis une erreur
journalisée portant l'identifiant du compte et le montant, récupérable à la main.

⚠️ **C'est un plafond assumé, pas une solution complète.** La sortie propre est une table d'« outbox »
écrite dans la même transaction que la fin de run et rejouée jusqu'à succès — aucune perte possible,
même base injoignable. Elle n'est pas de cette étape : elle demande une seconde table et un processus
de rejeu, et transformerait une étape dont le livrable est « l'or survit à la fermeture du
navigateur » en étape d'infrastructure. **Si une perte réelle est constatée, c'est la sortie.**

## 5. Ce que le joueur voit

Un **solde sur l'écran d'accueil**, et rien d'autre.

`GET /accounts/me`, jeton en en-tête `Authorization`, renvoie le solde. Le joueur ferme le navigateur,
revient, le nombre est là. C'est le livrable, et c'est vérifiable à la main en trente secondes.

Les deux alternatives écartées : un **historique des runs** (une seconde table, une seconde route, un
écran de plus — et le §3.1 a choisi une seule table), et un **solde dans le HUD** à côté de la
cagnotte non sécurisée, qui aurait rendu lisible la tension du §9.3 au moment où elle compte, mais au
prix du premier ajout d'octets par tick depuis l'étape 5a.

## 6. Vérification

**Le livrable, sur vraie socket :** une extraction crédite le compte, et **une seconde connexion avec
le même jeton voit le nouveau solde**. « L'or survit », littéralement.

Puis :

| Ce qui est asséné | Pourquoi ça ne peut pas être creux |
| --- | --- |
| Quatre joueurs, une extraction → **quatre** comptes crédités de la cagnotte **entière** | quatre vraies sockets ; la mutation « part égale » rougit |
| Le wipe crédite `gold × WIPE_GOLD_KEPT` par le **même** chemin | assertion **dérivée** de la constante, jamais un `0` écrit en dur — doctrine du docbloc de `REACTION_DAMAGE` |
| La ligne en base porte un `tokenHash` **différent** du jeton | la mutation « stocker en clair » rougit |
| L'URL du WebSocket ne contient **aucun** jeton, et les routes HTTP lisent l'en-tête | un jeton glissé dans l'URL rougit |
| Le même compte crédité depuis **deux salons** finit à la **somme** | la mutation « lire puis écrire » rougit sous concurrence |
| `SNAPSHOT`, `ZONE` et `REACTION` identiques **octet par octet** à avant | mesuré sur vraie socket, dans les deux sens, comme les étapes 5b et 5c |
| Un jeton **inconnu** fait refuser la connexion | |
| Un `BigInt` au-delà de `Int32` se lit et se réécrit sans perte | la mutation « colonne `Int` » rougit |

⚠️ **La réplication ne se mesure PAS ici.** Établi à l'étape 6a et revérifié à 5c : le décor d'un test
d'intégration balaie la horde par `Horde.kill`, qui court-circuite volontairement le lot `DEATHS`. Les
chiffres de dérive vivent dans `shared/horde.replication.test.ts`.

## 7. Écarts assumés

- **Un jeton perdu est un compte perdu**, sans recours, jusqu'à la promotion e-mail (§2.3).
- **Un joueur qui rejoint juste avant l'extraction touche tout** (§4.2). Traité à l'étape 9.
- **Pas d'outbox** : trois tentatives puis un journal (§4.4).
- **Pas d'historique de runs**, donc l'étape 7b devra équilibrer sa courbe de prix sans données
  réelles de progression.
- **Aucun classement**, donc l'anti-triche sur l'assistance au jeu reste hors sujet, comme le §11 le
  prévoit. Le serveur possède le solde : un client ne peut pas fabriquer d'or.
- **`POST /accounts` n'a pas de plafond par IP** (§2), donc la table des comptes est remplissable par
  une boucle. Aucun jeu ne s'y attache et une ligne est minuscule ; à traiter quand le jeu est exposé.
- **La CI gagne un service**, donc du temps. Elle tourne aujourd'hui en 13 minutes dont l'essentiel
  est `horde.replication.test.ts` ; une Postgres y ajoute ~1 minute.

## 8. Questions laissées ouvertes

- **Quand la promotion en compte e-mail arrive-t-elle ?** Elle est nécessaire dès qu'un joueur change
  d'appareil, donc probablement avant l'étape 9 et son matchmaking. Ce n'est pas 7a.
- **`WIPE_GOLD_KEPT` reste à `0`.** Cette étape rend son réglage gratuit, mais ne le règle pas : c'est
  une décision de playtest, et trois playtests sont déjà dus.
- **Le dév local a maintenant besoin d'une Postgres.** `deploy/compose.yaml` en a une ; reste à dire
  dans le README comment la lancer sans monter tout le reste.
