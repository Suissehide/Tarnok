# Tarnok

Un bullet heaven coopératif à 1-4 joueurs en ligne, où la coopération est une mécanique et
pas un habillage : chaque arme applique un élément, et c'est la rencontre de **deux**
éléments sur un même ennemi qui produit l'effet intéressant. Un joueur seul ne peut pas
couvrir assez d'éléments pour tout déclencher lui-même.

Cette dernière phrase est **mesurée** depuis l'étape 5c : six éléments font quinze paires,
quatre slots d'armes n'en atteignent que **six**, et les neuf autres demandent un deuxième
joueur. C'est asséné sur quatre vraies sockets
([le livrable](back/src/elements-5c.integration.test.ts)).

Des chevaliers, une forge, des hordes. Le détail est dans
[`docs/specs/2026-08-19-coop-survivors-orientation.md`](docs/specs/2026-08-19-coop-survivors-orientation.md).

## État

| Étape | Contenu | État |
| --- | --- | --- |
| 0 | Socle : dépôt, workspaces, CI, salon WebSocket minimal | ✅ |
| 1 | Bancs de performance | ✅ — [résultats](docs/plans/2026-08-24-banc-resultats.md) |
| 2 | Horde : flowfield, vagues data-driven, rendu batché | ✅ — [résultats](docs/plans/2026-08-24-etape-2-resultats.md) |
| 3 | Combat : tir au curseur, morts répliquées, orbes, niveaux, fin de run | ✅ — [résultats](docs/plans/2026-08-24-etape-3-resultats.md) |
| 4 | Draft : étalage à la montée de niveau, jetons visibles, conflits arbitrés | ✅ — [résultats](docs/plans/2026-08-26-etape-4-resultats.md) |
| 5a | Éléments : PV de la piétaille, zones au sol, première réaction, Synergie | ✅ — [résultats](docs/plans/2026-08-27-etape-5a-resultats.md) |
| 6a | Paliers, boss, or non sécurisé, vote d'extraction | 📝 — [spec](docs/specs/2026-09-01-etape-6a-paliers.md) · [plan](docs/plans/2026-09-01-etape-6a-paliers.md) |
| 5b | Foudre, Poix, armure, cinq réactions — **zéro octet de plus** | 📝 — [spec](docs/specs/2026-09-25-etape-5b-foudre-poix.md) · [plan](docs/plans/2026-09-25-etape-5b-foudre-poix.md) |
| 5c | Chaux, Vif-argent — **les six éléments, les quinze réactions**, tableau clos | 📝 — [spec](docs/specs/2026-09-26-etape-5c-chaux-vif-argent.md) · [plan](docs/plans/2026-09-26-etape-5c-chaux-vif-argent.md) · [résultats](docs/plans/2026-09-26-etape-5c-resultats.md) |
| 7a | Comptes anonymes, or persistant — **l'or survit à la fermeture du navigateur** | 📝 — [spec](docs/specs/2026-10-10-etape-7a-or-persistant.md) · [plan](docs/plans/2026-10-10-etape-7a-or-persistant.md) · [résultats](docs/plans/2026-10-10-etape-7a-resultats.md) |
| 7b | La boutique : six armes débloquables, améliorations permanentes | 📝 — [spec](docs/specs/2026-10-11-etape-7b-boutique.md) · [plan](docs/plans/2026-10-11-etape-7b-boutique.md) · [résultats](docs/plans/2026-10-11-etape-7b-resultats.md) |
| 8 | Classes : un verbe et un trait, choisis au salon — **zéro octet de plus par tick** | 📝 — [spec](docs/specs/2026-10-13-etape-8-classes.md) · [plan](docs/plans/2026-10-13-etape-8-classes.md) · [résultats](docs/plans/2026-10-13-etape-8-resultats.md) |
| 9 | Roue de ping : quatre intentions, flèches en bord d'écran — **zéro octet de plus par tick** | 📝 — [spec](docs/specs/2026-10-15-etape-9-ping.md) · [plan](docs/plans/2026-10-15-etape-9-ping.md) · [résultats](docs/plans/2026-10-15-etape-9-resultats.md) |
| 10 | Rareté (×1, ×2, ×3) et passifs qui s'empilent sans plafond — **zéro octet de plus par tick** | 📝 — [spec](docs/specs/2026-10-15-etape-10-rarete.md) · [plan](docs/plans/2026-10-15-etape-10-rarete.md) · [résultats](docs/plans/2026-10-15-etape-10-resultats.md) |
| 11 | Élites porteurs de coffre : une battue, un étalage d'au moins rares — **zéro octet de plus par tick** | 📝 — [spec](docs/specs/2026-10-15-etape-11-porteur.md) · [plan](docs/plans/2026-10-15-etape-11-porteur.md) · [résultats](docs/plans/2026-10-15-etape-11-resultats.md) |
| 14 | Événements bonus : sceaux, forge, convoi — un étalage d'au moins épiques | 📝 — [spec](docs/specs/2026-10-16-etape-14-evenements.md) · [plan](docs/plans/2026-10-16-etape-14-evenements.md) · [résultats](docs/plans/2026-10-16-etape-14-resultats.md) |

L'or gagné en run, qui survit depuis l'étape 7a, se dépense depuis l'étape 7b : une boutique à
l'écran d'accueil vend des améliorations permanentes de statistiques de départ, sur le modèle de
*Swarm*. Toutes les armes sont disponibles d'emblée. Un achat est définitif — pas de
remboursement, pas de remise à zéro — et change la run suivante, pas la run en cours.

Depuis l'étape 8, chaque joueur choisit au salon une **classe**, puis son arme de départ. Quatre
classes — Amorce, Rempart, Appât, Relais — apportent chacune **un verbe**, une capacité active à
recharge, et **un trait**, qui change une règle plutôt qu'un nombre. Le verbe se déclenche à la
touche Espace, visé au curseur ; le salon l'arbitre, l'annonce une fois, et chaque côté en dérive
l'effet — y compris le leurre de l'Appât, qui détourne la horde sans qu'elle dérive d'un pixel.

**Mille ennemis convergent identiquement sur cinq simulations, à partir d'un message de
19 octets** — contre ~150 ko/s si l'on répliquait leurs positions. C'est la mise en œuvre du
§3.3 de la spec d'orientation, et elle est mesurée : dérive de 0,000 px, identités
strictement égales.

Et elle survit au combat. La séparation **couple** les entités — retirer un ennemi en déplace
des dizaines — et les morts arrivent en retard. Le client revient donc au tick de la mort,
l'applique, et rejoue :

| | Dérive |
| --- | --- |
| Morts + séparation, **sans** rejeu | 332,888 px |
| Morts + séparation, **avec** rejeu | **0,000 px** |

Le chiffre de gauche compte autant que celui de droite : il mesure ce que le mécanisme ferait
sans ses corrections.

Le découpage complet est au §13 de la spec.

## Démarrer

```bash
npm install

cp back/.env.example back/.env      # PORT, CORS_ORIGIN
cp front/.env.example front/.env    # VITE_API_URL, VITE_WS_URL — doivent pointer sur le back

npm run dev -w back                 # http://localhost:3000
npm run dev -w front                # http://localhost:5173
```

Ouvrir deux onglets, créer un salon dans l'un, rejoindre avec le code dans l'autre.

> Si un autre projet occupe déjà le port 3000, changer `PORT` dans `back/.env` **et** les
> deux URL dans `front/.env` : elles doivent rester d'accord.

### La base

Le back a besoin d'une PostgreSQL depuis l'étape 7a. Pour n'en lancer qu'elle :

```bash
docker run --rm -d --name tarnok-db -p 127.0.0.1:5442:5432 \
  -e POSTGRES_USER=tarnok -e POSTGRES_PASSWORD=tarnok -e POSTGRES_DB=tarnok \
  postgres:16-alpine
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
npm run db:migrate -w back
```

La même image que `deploy/compose.yaml`, pour qu'aucune dérive ne soit possible. Le port est
5442, pas le 5432 par défaut de Postgres : ce dernier est fréquemment déjà pris par un autre
projet sur la machine d'un développeur.

`npm run db:migrate -w back` (comme toute commande Prisma) a besoin de `DATABASE_URL` : gardez
l'`export`. En revanche, `npm test` s'en passe si vous avez lancé le conteneur **exactement**
comme ci-dessus — à défaut de variable, les tests retombent sur cette même URL locale et le
disent une fois dans la sortie. Si votre Postgres écoute ailleurs (autre port, autre mot de
passe), l'`export` reste la seule voie correcte.

## Commandes

```bash
npm run lint          # biome check : format + lint en une passe, échoue si non formaté
npm run format        # biome check --write : corrige
npm run typecheck     # tsc --noEmit sur les deux paquets
npm test              # vitest
npm run bench -w back # bancs de simulation, réseau et séparation
```

Le banc de rendu est une page : `npm run dev -w front`, puis `/bench/render.html`.

## Structure

```
shared/    protocole binaire, flowfield, séparation, combat — code partagé, sans package.json
front/     client TypeScript : PixiJS v8, Tailwind, Vite
back/      serveur : Fastify (HTTP) + ws (jeu)
deploy/    Dockerfiles, compose Traefik, template nginx
docs/      specs, plans, maquettes
tools/     scripts hors chaîne de build
```

`shared/` est un **dossier de sources**, frère de `front/` et `back/`, résolu par l'alias
`@shared/*`. C'est le `package.json` racine qui lui fournit une racine de résolution.

Deux invariants que le code fait respecter, pas seulement la convention :

- **`back/src/room.ts` ne connaît pas le réseau.** Il reçoit des entrées, avance d'un pas
  fixe, écrit dans une *outbox*. Une règle Biome refuse d'y importer `ws` ou `fastify` —
  c'est ce qui rendra le passage à un salon par `worker_threads` mécanique plutôt qu'une
  réécriture.
- **Aucun asset sous licence dans l'historique.** Voir ci-dessous ; la CI échoue si un tel
  fichier est versionné.

## Assets

Le placeholder est [Tiny Swords](https://pixelfrog-assets.itch.io/tiny-swords) (Pixel Frog).
**La licence interdit la redistribution, même après modification**, et ce dépôt est public :
les assets n'y sont donc pas, et ne sont pas non plus dans les images Docker.

Ils vivent sur MinIO, bucket `tarnok`, à la racine :

```bash
cp deploy/.env.example .env   # renseigner les MINIO_*
./tools/fetch-assets.sh       # -> assets/tinyswords/ (gitignoré)
```

En production, nginx les sert sous le même chemin `/tinyswords/` en proxifiant MinIO, ce qui
fait que le CSS ne connaît jamais d'URL de bucket. Le bucket doit accorder `s3:GetObject` en
anonyme — et surtout pas `s3:ListBucket`. La politique exacte et le piège
console-contre-API-S3 sont dans [`NOTICE-assets.md`](NOTICE-assets.md).

## Conventions

Code et identifiants en anglais, commentaires et documentation en français.
[Conventional Commits](https://www.conventionalcommits.org/), imposés par commitlint au
`commit-msg`. Biome épinglé sans caret — un formateur qui change de version reformate tout
le dépôt et pollue chaque diff.
