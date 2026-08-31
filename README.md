# Tarnok

Un bullet heaven coopératif à 1-4 joueurs en ligne, où la coopération est une mécanique et
pas un habillage : chaque arme applique un élément, et c'est la rencontre de **deux**
éléments sur un même ennemi qui produit l'effet intéressant. Un joueur seul ne peut pas
couvrir assez d'éléments pour tout déclencher lui-même.

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
