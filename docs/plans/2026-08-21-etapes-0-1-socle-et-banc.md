# Tarnok — plan d'implémentation, étapes 0 et 1

Plan exécutable. Il couvre les deux premières étapes du §13 de
`docs/specs/2026-08-19-coop-survivors-orientation.md` : le **socle** et le **banc de
performance**. Rien de gameplay ici — ni éléments, ni draft, ni boss. C'est délibéré.

**L'étape 1 est une porte.** Son livrable n'est pas du code, c'est un tableau de chiffres.
Tant qu'il n'est pas rempli, la cible de 1 500 entités (§4.1), la carte immense et le
scaling ×N (§5) sont des hypothèses. On ne construit pas de gameplay sur des hypothèses de
budget.

---

## 0. Avant de commencer

### 0.1 Prérequis

| Outil | Rôle |
| --- | --- |
| Node LTS (22 ou plus) + npm | tout le projet |
| Docker + Docker Compose | Postgres en développement, déploiement |
| Python 3 + Pillow | régénération des sprites placeholder, hors chaîne de build |

### 0.2 Versions

**Une seule version est épinglée sans caret : Biome.** Un formateur qui change de version
en cours de route reformate tout le dépôt et pollue chaque diff. Le reste s'installe au
dernier stable et se laisse en caret.

> Les extraits de configuration ci-dessous sont écrits pour Biome 2.x. La forme exacte du
> schéma a bougé entre les majeures — **vérifier `biome.json` contre la doc de la version
> effectivement installée** avant de s'acharner sur une erreur de configuration.

### 0.3 Conventions

- **Code et identifiants en anglais, commentaires et documentation en français.** C'est la
  convention InkPoint, elle évite le franglais dans les noms de symboles.
- **Conventional Commits**, imposés par commitlint au `commit-msg`.
- Un module ne connaît jamais le socket. La logique de salon reçoit une *outbox* et écrit
  dedans. C'est ce qui rendra le passage en `worker_threads` (§3, un salon par worker)
  mécanique au lieu d'être une réécriture.

---

## 1. Arborescence cible

```
tarnok/
  package.json            workspaces front + back, outils partagés
  biome.json              une seule configuration pour tout le dépôt
  commitlint.config.js
  tsconfig.base.json      options communes + alias @shared/*
  .husky/commit-msg
  .github/workflows/ci.yml

  shared/                 dossier de sources, PAS un paquet npm
    protocol.ts           encodage binaire, types de messages
    constants.ts          taille de carte, cadences, limites

  front/
    package.json
    tsconfig.json
    vite.config.ts
    index.html
    src/
      main.ts
      net/client.ts       WebSocket, décodage, interpolation
      render/stage.ts     Pixi v8
      ui/                 DOM + Tailwind

  back/
    package.json
    tsconfig.json
    src/
      server.ts           Fastify (HTTP) + ws (jeu)
      room.ts             boucle à pas fixe, pure vis-à-vis du réseau
      rooms.ts            registre des salons, codes de salon

  deploy/
    Dockerfile.front
    Dockerfile.back
    nginx.conf
    compose.yaml
    .env.example

  docs/  tools/  assets/  (déjà en place)
```

`shared/` est un **dossier de sources TypeScript sans `package.json`**, résolu par un alias
`@shared/*` dans les deux tsconfig. Le `package.json` racine déclare les workspaces et sert
de racine de résolution — même raison que sur InkPoint : `shared/` est un frère de `front/`
et de `back/`, jamais leur descendant.

---

## 2. Étape 0 — le socle

**Livrable vérifiable : deux navigateurs ouverts sur le même code de salon, chacun voit son
carré et celui de l'autre bouger, et c'est le serveur qui décide des positions.**

### 2.1 Dépôt

```bash
mkdir -p shared front back deploy .github/workflows
git init
```

`.gitignore` existe déjà et couvre `node_modules/`, `dist/`, les assets Tiny Swords et les
deux maquettes. Ajouter `.env` et `back/.env`.

`.gitattributes` : forcer `* text=auto eol=lf` pour que les fins de ligne ne créent pas de
diffs fantômes entre machines.

### 2.2 Racine npm

`package.json` :

```json
{
  "name": "tarnok",
  "private": true,
  "workspaces": ["front", "back"],
  "scripts": {
    "lint": "biome check .",
    "format": "biome check --write .",
    "typecheck": "npm run typecheck -w front && npm run typecheck -w back",
    "test": "npm run test -w front && npm run test -w back",
    "prepare": "husky"
  },
  "devDependencies": {
    "@biomejs/biome": "2.4.5",
    "@commitlint/cli": "^19",
    "@commitlint/config-conventional": "^19",
    "husky": "^9",
    "typescript": "^5"
  }
}
```

### 2.3 Biome

`biome.json`, à la racine, **une seule configuration pour les trois dossiers** — un fichier
partagé ne peut pas être couvert par deux configurations concurrentes.

```json
{
  "$schema": "https://biomejs.dev/schemas/2.4.5/schema.json",
  "vcs": { "enabled": true, "clientKind": "git", "useIgnoreFile": true },
  "files": {
    "includes": ["**", "!**/dist/**", "!**/node_modules/**", "!assets/**", "!docs/maquettes/**"]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "javascript": {
    "formatter": { "quoteStyle": "single", "semicolons": "always", "trailingCommas": "all" }
  },
  "linter": {
    "enabled": true,
    "rules": { "recommended": true }
  },
  "assist": { "actions": { "source": { "organizeImports": "on" } } }
}
```

`docs/maquettes/**` est exclu volontairement : ce sont des pages autonomes avec du base64
inline, les reformater n'a aucun sens et fait exploser les diffs.

Vérification : `npm run lint` doit passer sur un dépôt vide, puis rester vert à chaque
commit.

### 2.4 husky + commitlint

```bash
npx husky init
printf 'npx --no -- commitlint --edit "$1"\n' > .husky/commit-msg
```

`commitlint.config.js` :

```js
module.exports = { extends: ['@commitlint/config-conventional'] };
```

Vérification : `git commit -m "wip"` doit être **refusé**, `git commit -m "chore: socle"`
accepté.

### 2.5 TypeScript

`tsconfig.base.json` :

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true,
    "baseUrl": ".",
    "paths": { "@shared/*": ["shared/*"] }
  }
}
```

`front/tsconfig.json` et `back/tsconfig.json` étendent ce fichier et ajoutent leurs
`include` (leur propre `src` **plus** `../shared`). Le back compile avec
`moduleResolution: "NodeNext"` s'il tourne en ESM Node — trancher au moment de le câbler,
et ne pas mélanger les deux.

Chaque paquet expose `"typecheck": "tsc --noEmit"`.

### 2.6 `shared/` — le protocole

Binaire dès le premier jour. Pas de JSON sur la boucle de jeu : c'est une décision du §3.6,
et rétrofitter du binaire sur un protocole JSON coûte toujours plus cher que de commencer
binaire.

`shared/constants.ts` :

```ts
export const TICK_HZ = 30;          // simulation serveur
export const SNAPSHOT_HZ = 20;      // diffusion serveur -> clients
export const INPUT_HZ = 30;         // client -> serveur
export const INTERP_DELAY_MS = 100; // buffer d'interpolation client
export const MAP_SIZE = 6000;       // provisoire, tranché par l'etape 1
export const MAX_PLAYERS = 4;
```

`shared/protocol.ts` — pour l'étape 0, trois messages suffisent :

```ts
export const MSG = { WELCOME: 1, SNAPSHOT: 2, INPUT: 3 } as const;

/** C -> S : une entree, 6 octets. */
export function encodeInput(seq: number, moveX: number, moveY: number): ArrayBuffer {
  const buf = new ArrayBuffer(5);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, seq, true);
  v.setInt8(3, clamp8(moveX));   // -127..127
  v.setInt8(4, clamp8(moveY));
  return buf;
}

/** S -> C : positions des joueurs, 4 + 5 octets par joueur. */
export function encodeSnapshot(tick: number, players: PlayerState[]): ArrayBuffer {
  const buf = new ArrayBuffer(6 + players.length * 5);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick, true);
  v.setUint8(5, players.length);
  let o = 6;
  for (const p of players) {
    v.setUint8(o, p.id);
    v.setInt16(o + 1, Math.round(p.x), true);
    v.setInt16(o + 3, Math.round(p.y), true);
    o += 5;
  }
  return buf;
}
```

`decodeInput` / `decodeSnapshot` symétriques, plus un `decode(buf)` qui lit le premier
octet et aiguille.

**Test dès maintenant** (`shared/protocol.test.ts`, Vitest) : encoder puis décoder rend
exactement l'entrée, et un buffer tronqué lève au lieu de rendre des valeurs fantaisistes.
C'est trois tests, et ils éviteront des heures de débogage réseau plus tard.

**Instrumentation dès maintenant, aussi.** Le §4.6 de la spec dit que la métrique qui a
plafonné Riot n'était ni le CPU ni la RAM mais l'overhead réseau. Donc `room.ts` compte, dès
sa première version, les **octets émis par tick** et les **µs passées à encoder**. Deux
compteurs, un `console.table` toutes les cinq secondes. Ça ne coûte rien maintenant et ça
n'existera jamais si on ne le fait pas maintenant.

### 2.7 `back/` — Fastify + ws

Dépendances : `fastify`, `ws`, et en développement `tsx`, `vitest`, `@types/ws`.

`back/src/room.ts` — **aucune référence au réseau**. Le salon reçoit des entrées, avance
d'un pas fixe, et écrit ses sorties dans une outbox que l'appelant vide.

```ts
export type Outbox = { push(msg: ArrayBuffer): void };

export class Room {
  private players = new Map<number, PlayerState>();
  private tick = 0;

  join(id: number): void { /* position de départ */ }
  leave(id: number): void { /* ... */ }
  applyInput(id: number, seq: number, mx: number, my: number): void { /* ... */ }

  /** Un pas de simulation. dt est fixe : 1 / TICK_HZ. */
  step(dt: number): void {
    this.tick++;
    for (const p of this.players.values()) {
      p.x += p.moveX * SPEED * dt;
      p.y += p.moveY * SPEED * dt;
      p.x = clamp(p.x, 0, MAP_SIZE);
      p.y = clamp(p.y, 0, MAP_SIZE);
    }
  }

  snapshot(out: Outbox): void {
    out.push(encodeSnapshot(this.tick, [...this.players.values()]));
  }
}
```

Cette classe est **testable sans serveur** : `step()` cent fois, vérifier la position. Un
test unitaire de salon dès l'étape 0.

`back/src/server.ts` :

- Fastify sert `GET /health` (pour le healthcheck compose) et `POST /rooms` (crée un salon,
  renvoie un code à quatre lettres).
- Un `WebSocketServer({ server })` de `ws` monté sur le serveur HTTP de Fastify, en écoutant
  l'événement `upgrade`. Le chemin porte le code de salon : `/ws?room=ABCD`.
- Une boucle à pas fixe **par salon**, avec accumulateur — pas un `setInterval` naïf :

```ts
let acc = 0, last = performance.now();
const STEP = 1000 / TICK_HZ;
setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  let steps = 0;
  while (acc >= STEP && steps < 5) { room.step(STEP / 1000); acc -= STEP; steps++; }
  if (steps === 5) acc = 0;      // on a pris du retard : on abandonne, on ne rattrape pas
  if (shouldBroadcast()) broadcast(room);
}, STEP / 2);
```

Le plafond de rattrapage n'est pas cosmétique : sans lui, une pause du process (GC, machine
qui dort) déclenche une avalanche de pas et le salon part en vrille.

### 2.8 `front/` — Vite + Pixi v8

Dépendances : `pixi.js` (v8), `vite`, `tailwindcss`, `typescript`, `vitest`.

`front/src/net/client.ts` :

- ouvre la WebSocket, gère `binaryType = 'arraybuffer'` ;
- envoie une entrée à `INPUT_HZ`, avec un `seq` incrémental ;
- garde un tampon des deux derniers snapshots et **interpole entre eux avec `INTERP_DELAY_MS`
  de retard**. Sans ce retard, tout tremble ;
- **prédit localement le carré du joueur** : on applique l'entrée immédiatement à l'écran, et
  on corrige quand le snapshot serveur arrive. Réconciliation naïve pour l'étape 0 —
  interpolation vers la position serveur sur ~100 ms. La vraie réconciliation par rejeu
  d'entrées appartient à l'étape 2.

`front/src/render/stage.ts` : Pixi v8, quatre `Graphics` ou sprites. On ne parle pas encore
de `ParticleContainer` — c'est le sujet de l'étape 1.

### 2.9 Le livrable de l'étape 0

Ouvrir deux onglets, rejoindre le même code de salon, bouger au clavier. Chaque onglet voit
les deux carrés. Couper le serveur : les deux carrés se figent — c'est la preuve que
l'autorité est bien serveur et pas locale.

### 2.10 Tests

Vitest dans les deux paquets. Trois familles, pas plus, à ce stade :

1. `shared/protocol.test.ts` — aller-retour d'encodage, buffer tronqué.
2. `back/src/room.test.ts` — `step()` déterministe sur une entrée connue, entrée d'un joueur
   absent ignorée sans planter.
3. `front` — au moins un test sur le tampon d'interpolation : deux snapshots, une position
   intermédiaire attendue.

### 2.11 CI

`.github/workflows/ci.yml` :

```yaml
name: ci
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
      - run: npm run build -w front
```

`npm run lint` utilise `biome check`, qui vérifie **format et lint en une passe** et échoue
si un fichier n'est pas formaté. C'est ce qu'on veut en CI : pas de débat de style en revue.

### 2.12 Déploiement

Même forme qu'InkPoint : deux images distinctes derrière Traefik, plus Postgres — que
l'étape 0 n'utilise pas encore mais qu'on câble tout de suite pour ne pas y revenir.

**`deploy/Dockerfile.front`** — build Vite puis nginx :

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY front/package.json front/
COPY back/package.json back/
RUN npm ci
COPY . .
ARG VITE_WS_URL
ARG VITE_API_URL
RUN npm run build -w front

FROM nginx:alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/front/dist /usr/share/nginx/html
```

**`deploy/Dockerfile.back`** :

```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY front/package.json front/
COPY back/package.json back/
RUN npm ci
COPY . .
RUN npm run build -w back

FROM node:22-alpine
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/back/dist back/dist
COPY --from=build /app/back/package.json back/
EXPOSE 3000
CMD ["node", "back/dist/server.js"]
```

**`deploy/compose.yaml`** — routage Traefik sur deux sous-domaines :

```yaml
services:
  front:
    build:
      context: ..
      dockerfile: deploy/Dockerfile.front
      args:
        VITE_WS_URL: wss://${TRAEFIK_API_HOST}/ws
        VITE_API_URL: https://${TRAEFIK_API_HOST}
    labels:
      - traefik.enable=true
      - traefik.http.routers.tarnok-front.rule=Host(`${TRAEFIK_FRONT_HOST}`)
      - traefik.http.routers.tarnok-front.entrypoints=websecure
      - traefik.http.routers.tarnok-front.tls.certresolver=le
      - traefik.http.services.tarnok-front.loadbalancer.server.port=80
    networks: [proxy]

  back:
    build: { context: .., dockerfile: deploy/Dockerfile.back }
    environment:
      PORT: 3000
      CORS_ORIGIN: https://${TRAEFIK_FRONT_HOST}
      DATABASE_URL: postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
    labels:
      - traefik.enable=true
      - traefik.http.routers.tarnok-api.rule=Host(`${TRAEFIK_API_HOST}`)
      - traefik.http.routers.tarnok-api.entrypoints=websecure
      - traefik.http.routers.tarnok-api.tls.certresolver=le
      - traefik.http.services.tarnok-api.loadbalancer.server.port=3000
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 10s
    depends_on: [db]
    networks: [proxy, internal]

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    volumes: [pgdata:/var/lib/postgresql/data]
    networks: [internal]

volumes: { pgdata: }
networks:
  proxy: { external: true }
  internal: {}
```

**`deploy/.env.example`** :

```
TRAEFIK_FRONT_HOST=tarnok.qwetle.fr     # ⚠️ hôte réel sur le serveur
TRAEFIK_API_HOST=api.tarnok.qwetle.fr   # ⚠️ hôte réel sur le serveur
POSTGRES_USER=tarnok
POSTGRES_PASSWORD=changeme              # ⚠️ vrai secret sur le serveur
POSTGRES_DB=tarnok
```

**`deploy/nginx.conf`** : servir `index.html` en repli sur toutes les routes
(`try_files $uri $uri/ /index.html;`), et rien d'autre. Le front ne proxifie pas l'API — le
sous-domaine s'en charge.

### 2.13 Critères de done, étape 0

- [ ] `npm run lint`, `npm run typecheck`, `npm test` verts en local et en CI.
- [ ] `git commit -m "wip"` refusé par commitlint.
- [ ] Deux onglets, un code de salon, les deux carrés bougent et le serveur arbitre.
- [ ] Serveur coupé → les carrés se figent.
- [ ] `room.ts` n'importe rien de `ws` ni de `fastify`.
- [ ] Compteurs octets/tick et µs d'encodage affichés côté serveur.
- [ ] `docker compose -f deploy/compose.yaml up --build` monte les trois services et
      `/health` répond.

---

## 3. Étape 1 — le banc de performance

**Livrable : un tableau de chiffres, commité dans `docs/plans/`.** Pas une impression, pas
un « ça a l'air de tenir ». Trois bancs indépendants, parce que les trois goulots sont
indépendants.

### 3.1 Banc serveur — `back/bench/sim.bench.ts`

Headless, sans réseau, sans rendu.

Le banc instancie N entités, leur applique une convergence par **flowfield** (§4.2 : grille
de coût, une passe par joueur, jamais d'A\* par agent) et mesure le temps d'un pas.

```
N = 250, 500, 1000, 1500, 2500, 4000
Mesure : ms par pas, médiane et p95 sur 600 pas
Verdict : le plus grand N dont le p95 reste sous 33 ms / 3 (marge pour le reste du tick)
```

Faire varier aussi la **taille de cellule du flowfield** (32, 64, 128 px) et la **fréquence
de recalcul** (5, 10, 20 Hz) : ce sont les deux boutons qui décideront de la taille de carte
au §15.2.

### 3.2 Banc client — `front/bench/render.html`

Une page autonome, Pixi v8, `ParticleContainer` alimenté par un `Float32Array`.

```
Sprites = 500, 1000, 1500, 3000, 6000
Mesure : fps stable sur 20 s, et ms passées dans le rendu
À comparer : ParticleContainer contre autant d'objets Sprite
```

Cette comparaison est le point du banc. Elle doit chiffrer l'écart, pas le supposer — c'est
lui qui justifie de n'écrire le rendu qu'une fois.

Ajouter un compteur de particules d'effet et vérifier à quel budget on perd 60 fps. Riot a
perdu 34 ms/frame sur les particules **avec** une équipe moteur (§4.3) ; c'est le poste à
surveiller, pas le nombre de sprites.

### 3.3 Banc réseau — `back/bench/net.bench.ts`

```
Entités répliquées = 4 joueurs + 0, 10, 20 élites
Mesure : octets par tick et par joueur, µs pour encoder + envoyer
Vérifier : l'estimation de 5-15 ko/s par joueur du §3.3
```

Et surtout, mesurer le coût **par salon** : c'est le plafond qu'a découvert Riot (~200
parties par machine, limité par les threads réseau).

### 3.4 Le tableau à remplir

À écrire dans ce dossier, sous `2026-XX-XX-banc-resultats.md` :

| Banc | Grandeur | Résultat | Machine |
| --- | --- | --- | --- |
| Sim | entités à 30 Hz, p95 < 11 ms | | |
| Sim | cellule de flowfield retenue | | |
| Rendu | sprites à 60 fps, ParticleContainer | | |
| Rendu | sprites à 60 fps, objets Sprite | | |
| Rendu | budget de particules à 60 fps | | |
| Réseau | ko/s par joueur, 4 joueurs | | |
| Réseau | µs d'encodage par tick | | |

Mesurer sur **deux machines** : la tienne, et une plus faible (un laptop d'il y a quatre ans,
ou Chrome avec un throttling CPU ×4). La cible se règle sur la seconde.

### 3.5 Ce qu'on décide selon le résultat

| Si le banc dit… | Alors |
| --- | --- |
| ≥ 1 500 entités à 30 Hz | la spec tient telle quelle, on passe à l'étape 2 |
| 800 à 1 500 | on garde la cible basse du §4.1 et on scale la densité plus prudemment (§5) |
| < 800 | **on rouvre le §4.1 et le §15.2** : carte plus petite, moins d'ennemis par joueur, ou piétaille en grappes plutôt qu'en entités individuelles |

Le troisième cas n'est pas un échec, c'est exactement pourquoi cette étape existe avant le
gameplay.

### 3.6 Critères de done, étape 1

- [ ] Trois bancs exécutables par une commande npm.
- [ ] Tableau rempli, commité, avec les caractéristiques des deux machines.
- [ ] Une phrase de décision écrite dans la spec, au §4.1, remplaçant l'estimation par le
      chiffre mesuré.

---

## 4. Commandes du quotidien

```bash
npm run lint          # biome check : format + lint, échoue si non formaté
npm run format        # biome check --write : corrige
npm run typecheck     # tsc --noEmit sur les deux paquets
npm test              # vitest
npm run dev -w front  # Vite, http://localhost:5173
npm run dev -w back   # tsx watch, http://localhost:3000
npm run bench -w back # bancs sim et réseau
```

---

## 5. Pièges connus

**Le piège d'InkPoint, transposé.** Vite inline les variables `VITE_*` **au moment du
build**, pas au démarrage du conteneur. Si `VITE_WS_URL` n'est pas passé en `ARG` au
`docker build`, le bundle livré retombe silencieusement sur `localhost` et, sur un site en
HTTPS, chaque connexion est bloquée en contenu mixte. Le joueur lit « connexion
impossible » pour ce qui est une erreur de déploiement. **Vérifier le bundle produit, pas
seulement que la CI est verte.**

**wss, pas ws.** Servi en HTTPS, le front doit ouvrir `wss://`. Une URL en `ws://` est
bloquée par le navigateur, avec un message peu explicite. C'est la même erreur que
ci-dessus, sous un autre déguisement.

**Le serveur de jeu est à état.** Un salon vit dans la mémoire d'un process. Dès qu'on
passe à plus d'une réplique de `back`, un round-robin envoie les joueurs d'un même salon sur
des process différents et rien ne fonctionne. Deux réponses, à trancher avant de scaler :
affinité de session Traefik (`loadbalancer.sticky.cookie`), ou routage par code de salon.
**Ne pas monter les répliques avant d'avoir choisi.**

**Le rattrapage de boucle.** Le plafond de cinq pas du §2.7 est là pour de vrai. Sans lui, un
process mis en pause quelques secondes rattrape des centaines de pas d'un coup et téléporte
tout le monde.

**Biome et les maquettes.** `docs/maquettes/*.html` contient des sprites en base64 sur des
lignes de plusieurs dizaines de milliers de caractères. Ils sont exclus dans `biome.json` ;
si un jour le lint devient inexplicablement lent, vérifier que l'exclusion tient toujours.

**Les assets Tiny Swords.** `assets/tinyswords-derived/` et les deux maquettes sont dans
`.gitignore` pour cause de licence (voir `NOTICE-assets.md`). Vérifier **avant le premier
push** que `git status` ne les propose pas — une fois dans l'historique, les retirer demande
une réécriture.
