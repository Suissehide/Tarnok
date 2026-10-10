# Étape 7a — l'or survit : plan d'implémentation

> **Pour les exécutants agentiques :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour
> implémenter ce plan tâche par tâche. Les étapes utilisent la syntaxe à cases (`- [ ]`).

**Goal :** chaque joueur a un compte dont le serveur possède le solde, et l'extraction y verse la
cagnotte — l'or survit à la fermeture du navigateur.

**Architecture :** un jeton anonyme frappé par `POST /accounts`, stocké **haché** côté serveur et en
clair dans le `localStorage` du client. Il voyage en en-tête `Authorization` sur HTTP et comme
**premier message binaire** (`MSG.HELLO`) sur le WebSocket — jamais dans une URL. Une table
`Account` en PostgreSQL via Prisma, testée sur une **vraie** Postgres avec un schéma par worker
Vitest. Le crédit a lieu au **drain de `RUN_OVER`** par `Session`, pas dans `Room`, qui reste sans
I/O.

**Tech Stack :** TypeScript, Fastify, `ws`, Prisma 6, PostgreSQL 16, Vitest 4, PixiJS v8 (front),
Biome, commitlint.

**Spec :** [`../specs/2026-10-10-etape-7a-or-persistant.md`](../specs/2026-10-10-etape-7a-or-persistant.md)

## Contraintes globales

- **`shared/` est un frère de `front/` et `back/`**, importé par l'alias `@shared/*`. Il n'a pas de
  `package.json`. Il ne doit **jamais** importer Prisma ni rien de serveur.
- **Commentaires et docblocs en français, sans accents dans le code** : le dépôt écrit `declenche`,
  pas `déclenché`. Les documents `.md`, eux, sont accentués.
- **commitlint** : sujet en minuscules, type dans
  `build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test`.
- **Chaque message de commit finit par** `Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83`
- **Biome** : `npm run lint` doit être vert avant tout commit (il vérifie format ET lint).
- **`GOLD_MAX = 0xffff_ffff`** (4 294 967 295). La colonne de solde est un **`BigInt`**, parce
  qu'un `Int` PostgreSQL plafonne à 2 147 483 647 et déborderait dès la première run au plafond.
- **`TOKEN_BYTES = 32`**, **`HELLO_BYTES = 33`** (1 octet de type + 32 de jeton). Largeur **fixe**,
  jamais un préfixe de longueur.
- **Aucun octet de plus par tick.** `SNAPSHOT`, `ZONE`, `REACTION` ne bougent pas.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : les serveurs de dév de l'auteur tournent
  sur les ports 5173 et 3100.
- **Le dépôt est public** et la licence Tiny Swords interdit la redistribution : aucun actif du pack
  dans git.
- **Ne pas lancer la suite complète ni les bancs** si tu es un sous-agent : uniquement tes fichiers
  ciblés. Le portique complet appartient au coordinateur, qui le lance seul.

## Review Focus

Cinq classes d'entrée que la spec implique sans qu'aucune tâche ne les exerce naturellement. Chaque
ligne a son test rattaché à la tâche qui possède le code.

1. **Un `HELLO` tronqué ou de mauvaise longueur** (0 octet, 10 octets, 40 octets) — la socket doit se
   fermer proprement, pas lever une exception non attrapée qui tuerait le salon des autres. → tâche 1
   et tâche 5.
2. **Deux `HELLO` sur la même socket** — le second doit être ignoré ou fermer la socket, jamais
   attribuer un deuxième slot au même client. → tâche 5.
3. **`GET /accounts/me` sans en-tête, avec un en-tête vide, ou avec un jeton inconnu** — doit rendre
   401, jamais 500 ni un solde de `0` qui se lirait comme « compte vide ». → tâche 4.
4. **Un solde au-delà de `Int32`** écrit puis relu — doit revenir exact, et se sérialiser en JSON sans
   lever (`bigint` n'est pas sérialisable nativement). → tâche 2 et tâche 4.
5. **Deux crédits concurrents sur le même compte** — le solde final doit être la **somme**, ce qu'un
   lire-modifier-écrire perdrait silencieusement. → tâche 6.

---

## Tâche 1 : le jeton sur le fil — `MSG.HELLO`

Pure, sans base, sans serveur. Elle se teste seule et en une seconde.

**Files :**
- Modify: `shared/protocol.ts`
- Test: `shared/protocol.test.ts`

**Interfaces :**
- Consumes: rien.
- Produces: `MSG.HELLO = 20`, `TOKEN_BYTES = 32`, `HELLO_BYTES = 33`,
  `encodeHello(token: Uint8Array): ArrayBuffer`, `decodeHello(buf: ArrayBuffer): HelloMessage`,
  `interface HelloMessage { type: typeof MSG.HELLO; token: Uint8Array }`, et `HelloMessage` ajouté à
  l'union `Message`.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/protocol.test.ts`, à la fin du fichier :

```ts
describe('etape 7a tache 1 : HELLO porte le jeton, en largeur FIXE', () => {
  /**
   * ⚠️ **Les deux largeurs sont epinglees en chiffres NUS.** Une assertion
   * `toBe(HELLO_BYTES)` serait vraie quoi qu'il arrive — c'est la meme raison
   * qui fait epingler 22 et 9 pour le snapshot plus haut dans ce fichier.
   */
  it('HELLO_BYTES vaut 33, et TOKEN_BYTES vaut 32', () => {
    expect(TOKEN_BYTES).toBe(32);
    expect(HELLO_BYTES).toBe(33);
    expect(HELLO_BYTES).toBe(1 + TOKEN_BYTES);
  });

  it('un jeton de 32 octets fait l aller-retour a l identique', () => {
    const token = new Uint8Array(TOKEN_BYTES);
    for (let i = 0; i < TOKEN_BYTES; i++) {
      token[i] = (i * 7 + 3) & 0xff;
    }
    const buf = encodeHello(token);
    expect(buf.byteLength).toBe(33);

    const msg = decode(buf);
    expect(msg.type).toBe(MSG.HELLO);
    if (msg.type !== MSG.HELLO) {
      throw new Error('type inattendu');
    }
    expect([...msg.token]).toEqual([...token]);
  });

  it('HELLO ne marche PAS sur le meme identifiant qu un message existant', () => {
    const existants = Object.entries(MSG)
      .filter(([nom]) => nom !== 'HELLO')
      .map(([, id]) => id);
    expect(existants).not.toContain(MSG.HELLO);
  });

  /**
   * Review Focus n°1 : un HELLO tronque doit LEVER a l'encodage comme au
   * decodage, jamais rendre un jeton a moitie lu. C'est `viewOf` qui garde le
   * decodage ; l'encodage se garde lui-meme, parce qu'un jeton trop court
   * produirait un message de la bonne taille avec des zeros a la fin — donc un
   * jeton VALIDE mais faux.
   */
  it('refuse un jeton qui ne fait pas exactement TOKEN_BYTES', () => {
    expect(() => encodeHello(new Uint8Array(0))).toThrow();
    expect(() => encodeHello(new Uint8Array(TOKEN_BYTES - 1))).toThrow();
    expect(() => encodeHello(new Uint8Array(TOKEN_BYTES + 1))).toThrow();
  });

  it('refuse un buffer HELLO tronque', () => {
    const court = new ArrayBuffer(10);
    new DataView(court).setUint8(0, MSG.HELLO);
    expect(() => decode(court)).toThrow(/tronque/);
  });
});
```

Ajouter `HELLO_BYTES`, `TOKEN_BYTES`, `encodeHello` et `decodeHello` à l'import depuis
`./protocol` en tête de `shared/protocol.test.ts`.

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd back && npx vitest run ../shared/protocol.test.ts
```

Attendu : ÉCHEC à la compilation — `TOKEN_BYTES` et `encodeHello` n'existent pas.

- [ ] **Étape 3 : écrire l'implémentation minimale**

Dans `shared/protocol.ts`, ajouter `HELLO: 20,` à la fin de l'objet `MSG` (après
`PORTAL_RESULT: 19,`).

Puis, près des autres largeurs (à côté de `VOTE_BYTES = 2`) :

```ts
/**
 * Longueur du jeton de compte, en octets — 32 octets de hasard
 * cryptographique, soit 43 caracteres en base64url.
 *
 * ⚠️ **Largeur FIXE, pas un prefixe de longueur.** Tout le protocole de ce
 * depot est a largeur fixe ou a compte explicite ; un jeton de longueur
 * variable ajouterait le seul champ du fil dont la taille depend de son
 * contenu, pour rien — un jeton n'a aucune raison de varier.
 */
export const TOKEN_BYTES = 32;

/** `type u8 · token[32]`. */
export const HELLO_BYTES = 1 + TOKEN_BYTES;
```

L'interface, à côté de `VoteMessage` :

```ts
/**
 * C -> S : le PREMIER message de toute socket de jeu, avant l'attribution du
 * slot.
 *
 * ⚠️ **C'est le seul endroit par lequel le jeton atteint le serveur sur le
 * canal de jeu, et c'est voulu : il ne passe JAMAIS par une URL.** Une URL
 * atterrit dans les journaux du reverse proxy, dans `Referer` et dans
 * l'historique du navigateur — et ce jeton EST le compte (§2.3 de la spec). Le
 * navigateur interdisant les en-tetes personnalises sur un WebSocket, un
 * premier message est la seule voie qui n'expose rien.
 */
export interface HelloMessage {
  type: typeof MSG.HELLO;
  token: Uint8Array;
}
```

Ajouter `| HelloMessage` à l'union `Message`.

Les codecs, à côté de `encodeVote` :

```ts
/**
 * C -> S : presente le jeton de compte.
 *
 * ⚠️ **Leve si le jeton ne fait pas exactement `TOKEN_BYTES`.** Sans cette
 * garde, un jeton trop court produirait un message de la BONNE taille complete
 * par des zeros : un jeton valide sur le fil, et faux. L'erreur serait alors un
 * refus d'authentification inexplicable, loin de sa cause.
 */
export function encodeHello(token: Uint8Array): ArrayBuffer {
  if (token.length !== TOKEN_BYTES) {
    throw new Error(`jeton de ${token.length} octets, ${TOKEN_BYTES} attendus`);
  }
  const buf = new ArrayBuffer(HELLO_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.HELLO);
  new Uint8Array(buf, 1, TOKEN_BYTES).set(token);
  return buf;
}

function decodeHello(buf: ArrayBuffer): HelloMessage {
  viewOf(buf, HELLO_BYTES);
  return { type: MSG.HELLO, token: new Uint8Array(buf.slice(1, HELLO_BYTES)) };
}
```

⚠️ `buf.slice(1, HELLO_BYTES)` **copie** : une vue sur le buffer de la socket serait invalidée
dès la trame suivante.

Et le cas dans `decode` :

```ts
    case MSG.HELLO:
      return decodeHello(buf);
```

- [ ] **Étape 4 : lancer les tests pour vérifier qu'ils passent**

```bash
cd back && npx vitest run ../shared/protocol.test.ts
```

Attendu : tout vert.

- [ ] **Étape 5 : lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add shared/protocol.ts shared/protocol.test.ts
git commit -m "feat(shared): HELLO porte le jeton de compte, en largeur fixe

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 2 : la base, le dépôt, et une vraie Postgres dans la CI

La plus grosse tâche du plan, et elle est indivisible : son test ne peut pas tourner sans sa
migration, et sa migration ne sert à rien sans la CI qui la joue.

**Files :**
- Create: `back/prisma/schema.prisma`
- Create: `back/src/accounts.ts`
- Create: `back/src/accounts.test.ts`
- Create: `back/test/setup-db.ts`
- Modify: `back/package.json` (dépendances et scripts)
- Modify: `back/vitest.config.ts` (le `globalSetup` et le `setupFiles`)
- Modify: `.github/workflows/ci.yml`
- Modify: `deploy/.env.example` (rien à changer si `DATABASE_URL` y est déjà — vérifier)
- Modify: `README.md` (comment lancer une Postgres locale)

**Interfaces :**
- Consumes: rien de la tâche 1.
- Produces: depuis `back/src/accounts.ts` —
  - `hashToken(token: Uint8Array): string` (sha256 en hexadécimal, 64 caractères)
  - `newToken(): Uint8Array` (32 octets de `crypto.randomBytes`)
  - `tokenToText(token: Uint8Array): string` / `textToToken(text: string): Uint8Array` (base64url)
  - `createAccount(): Promise<{ id: string; token: Uint8Array }>`
  - `findAccountIdByToken(token: Uint8Array): Promise<string | null>`
  - `goldOf(accountId: string): Promise<bigint>`
  - `creditAccounts(accountIds: readonly string[], amount: bigint): Promise<void>`
  - `prisma` (le client, exporté pour que les tests puissent nettoyer)

- [ ] **Étape 1 : installer Prisma**

```bash
npm install -w back @prisma/client
npm install -w back -D prisma
```

- [ ] **Étape 2 : écrire le schéma**

`back/prisma/schema.prisma` :

```prisma
// La PREMIERE base du projet. Le §12 de la spec d'orientation a tranche la
// pile (Prisma + PostgreSQL) des l'etape 0, et deploy/compose.yaml declare
// deja une postgres:16-alpine avec son volume : il ne manquait que
// l'applicatif.
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

/// Un compte anonyme. Cree sans friction a la premiere partie (§11 de
/// l'orientation), identifie par un jeton dont seul le sha256 est stocke.
model Account {
  id        String   @id @default(uuid())
  /// sha256 du jeton, en hexadecimal. Le jeton EN CLAIR n'est jamais stocke :
  /// un dump de cette table ne donne donc aucun compte.
  tokenHash String   @unique
  /// ⚠️ BigInt, et c'est un CALCUL, pas une precaution. GOLD_MAX vaut
  /// 0xffffffff = 4 294 967 295 (le plein u32, borne du fil posee a l'etape
  /// 6a), alors qu'un Int PostgreSQL plafonne a 2 147 483 647. Un Int
  /// deborderait des la PREMIERE run au plafond, pas « a terme ».
  gold      BigInt   @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Étape 3 : ajouter les scripts**

Dans `back/package.json`, section `scripts` :

```json
    "db:generate": "prisma generate",
    "db:migrate": "prisma migrate deploy",
    "db:dev": "prisma migrate dev"
```

- [ ] **Étape 4 : créer la migration**

Lancer une Postgres locale, puis :

```bash
cd back
DATABASE_URL='postgresql://tarnok:changeme@127.0.0.1:5432/tarnok' npx prisma migrate dev --name compte-et-or
```

Cela crée `back/prisma/migrations/<horodatage>_compte_et_or/migration.sql`. **Committer ce
fichier** — une migration non versionnée est une base non reproductible.

- [ ] **Étape 5 : écrire les tests qui échouent**

`back/src/accounts.test.ts` :

```ts
import { randomBytes } from 'node:crypto';
import { GOLD_MAX } from '@shared/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  createAccount,
  creditAccounts,
  findAccountIdByToken,
  goldOf,
  hashToken,
  newToken,
  prisma,
  textToToken,
  tokenToText,
} from './accounts';

beforeEach(async () => {
  await prisma.account.deleteMany();
});

describe('etape 7a tache 2 : le compte, et son jeton jamais stocke en clair', () => {
  it('un compte se cree, et son jeton le retrouve', async () => {
    const { id, token } = await createAccount();
    expect(await findAccountIdByToken(token)).toBe(id);
  });

  it('un jeton inconnu ne retrouve rien', async () => {
    await createAccount();
    expect(await findAccountIdByToken(newToken())).toBeNull();
  });

  /**
   * ⚠️ **La ligne en base ne doit porter AUCUNE trace du jeton.** Un dump de
   * cette table ne doit pas suffire a se faire passer pour un joueur. C'est la
   * propriete du §2 de la spec, et la mutation « stocker le jeton en clair »
   * doit rougir ICI.
   */
  it('la base stocke le HACHE, jamais le jeton', async () => {
    const { token } = await createAccount();
    const lignes = await prisma.account.findMany();
    expect(lignes).toHaveLength(1);
    const ligne = lignes[0];
    if (!ligne) {
      throw new Error('une ligne attendue');
    }
    expect(ligne.tokenHash).toBe(hashToken(token));
    expect(ligne.tokenHash).not.toBe(tokenToText(token));
    // 64 caracteres hexadecimaux : un sha256, pas le jeton.
    expect(ligne.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un compte neuf part a zero', async () => {
    const { id } = await createAccount();
    expect(await goldOf(id)).toBe(0n);
  });

  it('crediter ajoute, et crediter deux fois cumule', async () => {
    const { id } = await createAccount();
    await creditAccounts([id], 120n);
    expect(await goldOf(id)).toBe(120n);
    await creditAccounts([id], 80n);
    expect(await goldOf(id)).toBe(200n);
  });

  it('crediter plusieurs comptes les sert tous, du MEME montant', async () => {
    const a = await createAccount();
    const b = await createAccount();
    const c = await createAccount();
    await creditAccounts([a.id, b.id, c.id], 1200n);
    expect(await goldOf(a.id)).toBe(1200n);
    expect(await goldOf(b.id)).toBe(1200n);
    expect(await goldOf(c.id)).toBe(1200n);
  });

  /**
   * Review Focus n°4 : la colonne doit tenir ce que le FIL peut transporter.
   * `GOLD_MAX` vaut le plein u32 et depasse deja `Int32` : la mutation
   * « colonne Int » rougit ici, et elle rougit au PREMIER credit au plafond,
   * pas apres mille runs.
   */
  it('un solde au-dela d Int32 se reecrit et se relit sans perte', async () => {
    const INT32_MAX = 2_147_483_647n;
    expect(BigInt(GOLD_MAX)).toBeGreaterThan(INT32_MAX);

    const { id } = await createAccount();
    await creditAccounts([id], BigInt(GOLD_MAX));
    expect(await goldOf(id)).toBe(BigInt(GOLD_MAX));

    // Et une seconde run au plafond : largement au-dela d'Int32.
    await creditAccounts([id], BigInt(GOLD_MAX));
    expect(await goldOf(id)).toBe(BigInt(GOLD_MAX) * 2n);
  });

  it('le jeton fait l aller-retour en base64url', () => {
    const t = newToken();
    expect(tokenToText(t)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect([...textToToken(tokenToText(t))]).toEqual([...t]);
  });

  it('un texte qui n est pas un jeton leve plutot que de rendre n importe quoi', () => {
    expect(() => textToToken('trop-court')).toThrow();
    expect(() => textToToken(tokenToText(randomBytes(16)))).toThrow();
  });
});
```

- [ ] **Étape 6 : l'isolation par schéma, un par worker Vitest**

`back/test/setup-db.ts` :

```ts
/**
 * ⚠️ **Un schema PostgreSQL par worker Vitest, et c'est ce qui permet de
 * garder le parallelisme de fichiers.**
 *
 * Vitest execute les fichiers de test en parallele. Deux fichiers qui
 * `deleteMany()` la meme table se pietineraient, et le symptome serait un
 * rouge intermittent qui ne dit rien du contrat garde — exactement ce que ce
 * depot a paye trois fois a l'etape 5c sur des DELAIS.
 *
 * `VITEST_WORKER_ID` vaut « 1 », « 2 »… : chaque worker travaille donc dans
 * son propre schema, cree a la demande, et personne ne voit les lignes des
 * autres.
 */
import { execSync } from 'node:child_process';

const base = process.env.DATABASE_URL;
if (!base) {
  throw new Error(
    'DATABASE_URL manquante. Lance une Postgres (voir le README) et exporte la variable.',
  );
}

const worker = process.env.VITEST_WORKER_ID ?? '1';
const schema = `test_${worker}`;
const url = new URL(base);
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();

// `migrate deploy` cree le schema s'il manque et y joue les migrations. Il est
// idempotent : un second appel ne fait rien.
execSync('npx prisma migrate deploy', {
  cwd: new URL('..', import.meta.url).pathname,
  env: process.env,
  stdio: 'pipe',
});
```

Dans `back/vitest.config.ts`, à l'intérieur de `test: { … }`, ajouter :

```ts
    // ⚠️ `setupFiles`, pas `globalSetup` : il faut que ca tourne UNE FOIS PAR
    // WORKER (chacun a son schema), pas une fois pour toute la suite.
    setupFiles: ['./test/setup-db.ts'],
```

- [ ] **Étape 7 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd back && npx vitest run src/accounts.test.ts
```

Attendu : ÉCHEC — `./accounts` n'existe pas.

- [ ] **Étape 8 : écrire l'implémentation**

`back/src/accounts.ts` :

```ts
import { createHash, randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

/**
 * ⚠️ **Un seul client pour tout le processus.** Chaque `new PrismaClient()`
 * ouvre son propre pool de connexions ; en ouvrir un par salon epuiserait les
 * connexions de la base bien avant d'epuiser la memoire.
 */
export const prisma = new PrismaClient();

/** Longueur du jeton, en octets — doit valoir `TOKEN_BYTES` du protocole. */
const TOKEN_LENGTH = 32;

/** 32 octets de hasard cryptographique. */
export function newToken(): Uint8Array {
  return new Uint8Array(randomBytes(TOKEN_LENGTH));
}

/**
 * Le sha256 du jeton, en hexadecimal.
 *
 * ⚠️ **C'est la SEULE forme du jeton qui touche la base.** Un jeton en clair
 * stocke ferait d'un dump de table une liste de comptes utilisables.
 */
export function hashToken(token: Uint8Array): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Le jeton tel qu'il voyage en HTTP et vit dans `localStorage` : base64url. */
export function tokenToText(token: Uint8Array): string {
  return Buffer.from(token).toString('base64url');
}

/**
 * L'inverse, qui **leve** plutot que de rendre un jeton tronque.
 *
 * Sans cette garde, un en-tete `Authorization` mal forme produirait un jeton
 * court, donc un hache valide, donc un « compte inconnu » — un 401 correct
 * pour une mauvaise raison, et indebuggable.
 */
export function textToToken(text: string): Uint8Array {
  const buf = Buffer.from(text, 'base64url');
  if (buf.length !== TOKEN_LENGTH) {
    throw new Error(`jeton de ${buf.length} octets, ${TOKEN_LENGTH} attendus`);
  }
  return new Uint8Array(buf);
}

/** Frappe un compte et rend son jeton — la SEULE fois ou il est lisible. */
export async function createAccount(): Promise<{ id: string; token: Uint8Array }> {
  const token = newToken();
  const row = await prisma.account.create({
    data: { tokenHash: hashToken(token) },
    select: { id: true },
  });
  return { id: row.id, token };
}

export async function findAccountIdByToken(token: Uint8Array): Promise<string | null> {
  const row = await prisma.account.findUnique({
    where: { tokenHash: hashToken(token) },
    select: { id: true },
  });
  return row?.id ?? null;
}

export async function goldOf(accountId: string): Promise<bigint> {
  const row = await prisma.account.findUnique({
    where: { id: accountId },
    select: { gold: true },
  });
  return row?.gold ?? 0n;
}

/**
 * Ajoute `amount` au solde de CHACUN des comptes donnes.
 *
 * ⚠️ **Un `increment`, jamais un lire-modifier-ecrire.** Le meme jeton peut
 * etre ouvert dans deux onglets, donc dans deux salons : deux runs peuvent
 * finir au meme instant sur le meme compte. Un increment est juste sous
 * concurrence ; relire puis ecrire perdrait silencieusement l'un des deux.
 */
export async function creditAccounts(
  accountIds: readonly string[],
  amount: bigint,
): Promise<void> {
  if (accountIds.length === 0 || amount === 0n) {
    return;
  }
  await prisma.account.updateMany({
    where: { id: { in: [...accountIds] } },
    data: { gold: { increment: amount } },
  });
}
```

⚠️ **Pas de `timingSafeEqual` ici, et ce n'est pas un oubli.** La recherche se fait par **index
unique sur le haché** : la base compare un sha256 à un sha256, pas un secret à un secret. Il n'y a
donc aucune comparaison en temps constant à faire côté applicatif.

- [ ] **Étape 9 : lancer les tests pour vérifier qu'ils passent**

```bash
cd back && npx prisma generate && npx vitest run src/accounts.test.ts
```

Attendu : 9 tests verts.

- [ ] **Étape 10 : la Postgres dans la CI**

Dans `.github/workflows/ci.yml`, sous `check:`, entre `runs-on` et `steps` :

```yaml
    # La PREMIERE base du projet entre dans le portique. L'image est la MEME
    # que celle de deploy/compose.yaml : aucune derive entre ce qui est teste
    # et ce qui est deploye n'est donc possible — c'est la premiere forme du
    # « decor qui masque » recensee a l'etape 5c, et on la ferme d'avance.
    services:
      postgres:
        image: postgres:16-alpine
        env:
          POSTGRES_USER: tarnok
          POSTGRES_PASSWORD: tarnok
          POSTGRES_DB: tarnok
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U tarnok -d tarnok"
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10
```

Et, juste avant `- run: npm test` :

```yaml
      - run: npm run db:generate -w back
        env:
          DATABASE_URL: postgresql://tarnok:tarnok@127.0.0.1:5432/tarnok
```

Puis donner la variable à `npm test` :

```yaml
      - run: npm test
        env:
          DATABASE_URL: postgresql://tarnok:tarnok@127.0.0.1:5432/tarnok
```

- [ ] **Étape 11 : le README dit comment lancer une Postgres locale**

Ajouter dans `README.md`, dans la section de développement :

```markdown
### La base

Le back a besoin d'une PostgreSQL depuis l'étape 7a. Pour n'en lancer qu'elle :

```bash
docker run --rm -d --name tarnok-db -p 5432:5432 \
  -e POSTGRES_USER=tarnok -e POSTGRES_PASSWORD=tarnok -e POSTGRES_DB=tarnok \
  postgres:16-alpine
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5432/tarnok'
npm run db:migrate -w back
```

La même image que `deploy/compose.yaml`, pour qu'aucune dérive ne soit possible.
```

- [ ] **Étape 12 : lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add back/prisma back/src/accounts.ts back/src/accounts.test.ts back/test/setup-db.ts \
        back/package.json back/vitest.config.ts package-lock.json .github/workflows/ci.yml README.md
git commit -m "feat(back): un compte, un jeton hache, un solde en BigInt

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 3 : le jeton du protocole et celui du dépôt sont la MÊME longueur

Une tâche de trois lignes, et elle existe parce que deux constantes décrivant la même grandeur dans
deux fichiers qui ne se connaissent pas est exactement comment une largeur se met à diverger.

**Files :**
- Modify: `back/src/accounts.ts`
- Modify: `back/src/accounts.test.ts`

**Interfaces :**
- Consumes: `TOKEN_BYTES` de la tâche 1.
- Produces: rien de neuf.

- [ ] **Étape 1 : écrire le test qui échoue**

Dans `back/src/accounts.test.ts` :

```ts
  /**
   * ⚠️ **Deux constantes pour une seule grandeur, c'est une divergence qui
   * attend son tour.** `TOKEN_BYTES` borne le fil, `TOKEN_LENGTH` borne la
   * frappe du jeton. Si elles divergeaient, tout jeton frappe serait refuse a
   * l'encodage — et le symptome serait « personne ne peut se connecter ».
   */
  it('le jeton frappe fait exactement TOKEN_BYTES du protocole', () => {
    expect(newToken().length).toBe(TOKEN_BYTES);
  });
```

Ajouter `TOKEN_BYTES` à l'import depuis `@shared/protocol`.

- [ ] **Étape 2 : lancer, vérifier que ça passe déjà**

```bash
cd back && npx vitest run src/accounts.test.ts
```

Attendu : VERT — les deux valent 32. Le test ne corrige rien, **il empêche**.

- [ ] **Étape 3 : supprimer la duplication**

Dans `back/src/accounts.ts`, remplacer

```ts
/** Longueur du jeton, en octets — doit valoir `TOKEN_BYTES` du protocole. */
const TOKEN_LENGTH = 32;
```

par

```ts
import { TOKEN_BYTES } from '@shared/protocol';
```

et remplacer les trois usages de `TOKEN_LENGTH` par `TOKEN_BYTES`.

⚠️ **Vérifier que `back/tsconfig.json` et `back/vitest.config.ts` résolvent bien `@shared/*` depuis
du code de production** (et pas seulement depuis les tests) — ils le font déjà pour `room.ts`, donc
rien à changer, mais le typecheck le dira.

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/accounts.test.ts
cd .. && npm run lint && npm run typecheck
git add back/src/accounts.ts back/src/accounts.test.ts
git commit -m "refactor(back): une seule constante pour la longueur du jeton

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 4 : les deux routes HTTP

**Files :**
- Modify: `back/src/server.ts`
- Create: `back/src/accounts.http.test.ts`

**Interfaces :**
- Consumes: `createAccount`, `findAccountIdByToken`, `goldOf`, `textToToken`, `tokenToText` de la
  tâche 2.
- Produces: `POST /accounts` → `201 { token: string }` ; `GET /accounts/me` →
  `200 { gold: string }` ou `401`. Et, exportée depuis `server.ts`,
  `accountIdFromHeader(header: string | undefined): Promise<string | null>`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/accounts.http.test.ts` :

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma, tokenToText } from './accounts';
import { type App, buildServer } from './server';

let app: App;

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer({ roomSeed: 1 });
});

afterEach(async () => {
  await app.close();
});

describe('etape 7a tache 4 : les deux routes du compte', () => {
  it('POST /accounts frappe un compte et rend son jeton UNE fois', async () => {
    const res = await app.inject({ method: 'POST', url: '/accounts' });
    expect(res.statusCode).toBe(201);
    const { token } = res.json<{ token: string }>();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await prisma.account.count()).toBe(1);
  });

  it('deux appels frappent DEUX comptes differents', async () => {
    const a = (await app.inject({ method: 'POST', url: '/accounts' })).json<{ token: string }>();
    const b = (await app.inject({ method: 'POST', url: '/accounts' })).json<{ token: string }>();
    expect(a.token).not.toBe(b.token);
    expect(await prisma.account.count()).toBe(2);
  });

  it('GET /accounts/me rend le solde du porteur du jeton', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();
    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ gold: string }>().gold).toBe('0');
  });

  /**
   * Review Focus n°3 : les trois formes de « pas de jeton valide » doivent
   * rendre 401, jamais 500, et surtout **jamais un solde de 0** — qui se
   * lirait comme « ton compte est vide » alors que le compte n'a pas ete
   * trouve. Le joueur verrait son or disparaitre.
   */
  it('sans en-tete, avec un en-tete vide, ou avec un jeton inconnu : 401', async () => {
    const sans = await app.inject({ method: 'GET', url: '/accounts/me' });
    expect(sans.statusCode).toBe(401);

    const vide = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: '' },
    });
    expect(vide.statusCode).toBe(401);

    const malForme = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: 'Bearer pas-un-jeton' },
    });
    expect(malForme.statusCode).toBe(401);

    const inconnu = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${tokenToText(new Uint8Array(32))}` },
    });
    expect(inconnu.statusCode).toBe(401);

    for (const res of [sans, vide, malForme, inconnu]) {
      expect(res.body).not.toContain('"gold"');
    }
  });

  /**
   * Review Focus n°4 : `bigint` n'est pas serialisable en JSON. Sans
   * conversion explicite, cette route leverait « Do not know how to serialize
   * a BigInt » et rendrait 500 — pour tout solde, pas seulement les gros.
   */
  it('un solde au-dela d Int32 se serialise, en TEXTE', async () => {
    const { token } = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();
    const enorme = 9_000_000_000n;
    await prisma.account.updateMany({ data: { gold: enorme } });

    const res = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    // En TEXTE : un nombre JSON perdrait la precision au-dela de 2^53.
    expect(res.json<{ gold: string }>().gold).toBe('9000000000');
  });
});
```

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd back && npx vitest run src/accounts.http.test.ts
```

Attendu : ÉCHEC — les routes rendent 404.

- [ ] **Étape 3 : écrire l'implémentation**

Dans `back/src/server.ts`, ajouter l'import :

```ts
import { createAccount, findAccountIdByToken, goldOf, textToToken } from './accounts';
```

Puis, à côté de `app.post('/rooms', …)` :

```ts
/**
 * Lit le compte designe par un en-tete `Authorization: Bearer <jeton>`.
 *
 * ⚠️ **Rend `null` pour TOUTE forme d'echec**, et le fait sans distinguer
 * « en-tete absent », « en-tete mal forme » et « jeton inconnu » : les trois
 * doivent produire le meme 401. Distinguer renseignerait un attaquant sur
 * l'existence d'un compte.
 */
export async function accountIdFromHeader(header: string | undefined): Promise<string | null> {
  if (!header) {
    return null;
  }
  const texte = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  let token: Uint8Array;
  try {
    token = textToToken(texte.trim());
  } catch {
    return null;
  }
  return findAccountIdByToken(token);
}
```

Et les deux routes :

```ts
  // Le compte anonyme du §11 : aucun formulaire, aucun clic. Le client appelle
  // cette route au premier chargement ou son localStorage ne porte pas deja un
  // jeton, et jamais autrement.
  //
  // ⚠️ Pas de plafond par IP : la table est donc remplissable par une boucle.
  // Ecart assume au §7 de la spec, a traiter quand le jeu est expose.
  app.post('/accounts', async (_req, reply) => {
    const { token } = await createAccount();
    return reply.code(201).send({ token: tokenToText(token) });
  });

  app.get('/accounts/me', async (req, reply) => {
    const accountId = await accountIdFromHeader(req.headers.authorization);
    if (accountId === null) {
      return reply.code(401).send({ error: 'jeton absent ou inconnu' });
    }
    // ⚠️ **En TEXTE, pas en nombre.** `bigint` n'est pas serialisable en JSON,
    // et un nombre JSON perdrait la precision au-dela de 2^53 — alors que la
    // colonne, elle, tient jusqu'a 2^63.
    return reply.send({ gold: (await goldOf(accountId)).toString() });
  });
```

Ajouter `tokenToText` à l'import depuis `./accounts`.

- [ ] **Étape 4 : lancer les tests pour vérifier qu'ils passent**

```bash
cd back && npx vitest run src/accounts.http.test.ts
```

Attendu : 5 tests verts.

- [ ] **Étape 5 : lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add back/src/server.ts back/src/accounts.http.test.ts
git commit -m "feat(back): frappe un compte et lis son solde en http

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 5 : la poignée de main — `HELLO` avant le slot

La tâche invasive. Elle touche les quatre harnais d'intégration existants.

**Files :**
- Modify: `back/src/server.ts` (la classe `Session` et le gestionnaire `upgrade`)
- Modify: `back/src/draft.integration.test.ts`
- Modify: `back/src/elements.integration.test.ts`
- Modify: `back/src/portal.integration.test.ts`
- Modify: `back/src/elements-5c.integration.test.ts`
- Create: `back/src/handshake.integration.test.ts`

**Interfaces :**
- Consumes: `encodeHello` (tâche 1), `findAccountIdByToken` (tâche 2).
- Produces: `Session#add(ws: WebSocket): void` — **ne rend plus d'identifiant** ; l'attribution
  devient asynchrone, après `HELLO`. Et `Session#accountIdOf(playerId: number): string | undefined`.
  Nouvelles constantes exportées de `server.ts` : `CLOSE_NO_HELLO = 4003`,
  `CLOSE_UNKNOWN_TOKEN = 4004`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/handshake.integration.test.ts` :

```ts
import type { AddressInfo } from 'node:net';
import { encodeHello, MSG, TOKEN_BYTES } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, newToken, prisma } from './accounts';
import { type App, buildServer } from './server';

let app: App;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer({ roomSeed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function salon(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return res.json<{ code: string }>().code;
}

function ouvre(code: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  return ws;
}

function attendOuvert(ws: WebSocket): Promise<void> {
  return new Promise((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
}

/** Rend le premier message recu, ou le code de fermeture si la socket ferme. */
function premiere(ws: WebSocket): Promise<{ type?: number; closed?: number }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({}), 3000);
    ws.once('message', (data: ArrayBuffer) => {
      clearTimeout(t);
      resolve({ type: new DataView(data).getUint8(0) });
    });
    ws.once('close', (code) => {
      clearTimeout(t);
      resolve({ closed: code });
    });
  });
}

describe('etape 7a tache 5 : HELLO avant le slot', () => {
  it('un HELLO valide obtient un WELCOME', async () => {
    const code = await salon();
    const { token } = await createAccount();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeHello(token));
    expect(await premiere(ws)).toEqual({ type: MSG.WELCOME });
  });

  /**
   * ⚠️ **Le WELCOME ne doit PAS arriver avant le HELLO.** Si le serveur
   * attribuait le slot a l'ouverture de la socket comme avant, ce test
   * passerait sans que l'authentification serve a rien — et le compte ne serait
   * jamais lie au joueur.
   */
  it('aucun WELCOME tant que le HELLO n est pas envoye', async () => {
    const code = await salon();
    const ws = ouvre(code);
    await attendOuvert(ws);
    expect(await premiere(ws)).toEqual({});
  });

  it('un jeton inconnu fait fermer la socket', async () => {
    const code = await salon();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeHello(newToken()));
    const vu = await premiere(ws);
    expect(vu.closed).toBe(4004);
  });

  /**
   * Review Focus n°1 : un premier message qui n'est pas un HELLO, ou un HELLO
   * tronque, doit fermer CETTE socket — jamais lever une exception non
   * attrapee, qui couperait la partie des autres joueurs du salon.
   */
  it('un premier message qui n est pas un HELLO valide ferme cette socket seule', async () => {
    const code = await salon();
    const { token } = await createAccount();

    // Un joueur legitime, deja dans le salon.
    const bon = ouvre(code);
    await attendOuvert(bon);
    bon.send(encodeHello(token));
    expect(await premiere(bon)).toEqual({ type: MSG.WELCOME });

    for (const mauvais of [
      new ArrayBuffer(0),
      new ArrayBuffer(10),
      new ArrayBuffer(TOKEN_BYTES + 8),
    ]) {
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(mauvais);
      const vu = await premiere(ws);
      expect(vu.closed).toBeGreaterThanOrEqual(4000);
    }

    // Et le joueur legitime est toujours la : son salon n'est pas tombe.
    expect(bon.readyState).toBe(WebSocket.OPEN);
  });

  /**
   * Review Focus n°2 : un second HELLO ne doit JAMAIS attribuer un second
   * slot. Sans garde, un client bavard occuperait les quatre places a lui
   * seul.
   */
  /**
   * §2.1 de la spec : **le jeton ne passe JAMAIS par une URL.** Ce test le
   * prouve par la negative cote serveur — un client qui glisserait son jeton
   * dans la chaine de requete, sans envoyer de HELLO, ne doit obtenir AUCUN
   * slot. Si le serveur lisait l'URL, ce test passerait au vert et le jeton
   * se mettrait a fuir dans les journaux du reverse proxy.
   */
  it('un jeton dans l URL ne vaut RIEN : le serveur ne lit que le HELLO', async () => {
    const code = await salon();
    const { token } = await createAccount();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${code}&token=${Buffer.from(token).toString('base64url')}`,
    );
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);
    await attendOuvert(ws);
    // Aucun HELLO envoye, bien que l'URL porte un jeton valide.
    expect(await premiere(ws)).toEqual({});
  });

  it('un second HELLO n attribue pas un second slot', async () => {
    const code = await salon();
    const { token } = await createAccount();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeHello(token));
    expect(await premiere(ws)).toEqual({ type: MSG.WELCOME });

    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const avant = room.playerCount;
    ws.send(encodeHello(token));
    await new Promise((r) => setTimeout(r, 200));
    expect(room.playerCount).toBe(avant);
  });
});
```

⚠️ Vérifier le nom réel du compteur de joueurs sur `Room` (`playerCount` ou équivalent) avec
`grep -n "playerCount\|get players" back/src/room.ts` et l'utiliser tel quel.

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd back && npx vitest run src/handshake.integration.test.ts
```

Attendu : ÉCHEC — le WELCOME arrive avant tout `HELLO`.

- [ ] **Étape 3 : réécrire `Session#add`**

Remplacer, dans `back/src/server.ts`, le corps de `add` par :

```ts
  readonly #accounts = new Map<number, string>();

  /** Le compte lie a un slot, pour le credit de fin de run. */
  accountIdOf(playerId: number): string | undefined {
    return this.#accounts.get(playerId);
  }

  /**
   * Accepte une socket. **N'attribue PAS de slot tout de suite** : le slot
   * n'existe qu'une fois le `HELLO` presente et le compte reconnu.
   *
   * ⚠️ **C'est un changement de forme, pas seulement de contenu : `add` ne rend
   * plus d'identifiant.** Le salon plein ne peut plus se detecter a
   * l'ouverture, puisqu'une socket non authentifiee n'occupe aucune place — il
   * se detecte apres le `HELLO`, et ferme alors la socket.
   */
  add(ws: WebSocket): void {
    ws.binaryType = 'arraybuffer';

    const onFirst = async (data: ArrayBuffer): Promise<void> => {
      let token: Uint8Array;
      try {
        const msg = decode(data);
        if (msg.type !== MSG.HELLO) {
          ws.close(CLOSE_NO_HELLO, 'HELLO attendu');
          return;
        }
        token = msg.token;
      } catch {
        // Trame illisible ou tronquee : CETTE socket se ferme, jamais le
        // salon. Meme discipline que `#onFrame`.
        ws.close(CLOSE_BAD_FRAME, 'trame illisible');
        return;
      }

      const accountId = await findAccountIdByToken(token);
      if (accountId === null) {
        ws.close(CLOSE_UNKNOWN_TOKEN, 'jeton inconnu');
        return;
      }

      const id = this.#freeId();
      if (id === null || !this.room.join(id)) {
        ws.close(CLOSE_ROOM_FULL, 'salon plein');
        return;
      }

      // ⚠️ Le listener du premier message est retire AVANT d'installer le
      // suivant : sans ca, un second HELLO attribuerait un second slot au meme
      // client (Review Focus n°2).
      ws.off('message', onFirstSync);

      this.#clients.set(id, ws);
      this.#accounts.set(id, accountId);
      ws.send(encodeWelcome(id, this.room.tick, this.room.mapSeed));
      ws.on('message', (frame: ArrayBuffer) => {
        this.#onFrame(id, ws, frame);
      });
      ws.on('close', () => {
        this.remove(id);
      });
      ws.on('error', () => {
        this.remove(id);
      });
    };

    const onFirstSync = (data: ArrayBuffer): void => {
      void onFirst(data);
    };

    ws.on('message', onFirstSync);
    ws.on('close', () => {
      // Une socket qui part avant son HELLO n'a aucun slot a liberer.
    });
  }
```

Dans `remove`, ajouter `this.#accounts.delete(id);` à côté de `this.#clients.delete(id);`.

Les deux codes de fermeture, à côté des existants :

```ts
/** Premier message absent ou pas un `HELLO` (§2.2 de la spec de l'etape 7a). */
const CLOSE_NO_HELLO = 4003;
/** `HELLO` bien forme, jeton inconnu. */
const CLOSE_UNKNOWN_TOKEN = 4004;
```

Et dans le gestionnaire `upgrade`, remplacer

```ts
      if (session.add(ws) === null) {
        ws.close(CLOSE_ROOM_FULL, 'salon plein');
      }
```

par

```ts
      // Le salon plein se detecte apres le HELLO, pas ici : une socket non
      // authentifiee n'occupe aucune place.
      session.add(ws);
```

Ajouter `findAccountIdByToken` à l'import depuis `./accounts`.

- [ ] **Étape 4 : lancer les tests pour vérifier qu'ils passent**

```bash
cd back && npx vitest run src/handshake.integration.test.ts
```

Attendu : 6 tests verts.

- [ ] **Étape 5 : mettre les quatre harnais existants à jour**

Dans **chacun** de `draft.integration.test.ts`, `elements.integration.test.ts`,
`portal.integration.test.ts` et `elements-5c.integration.test.ts` :

1. Ajouter aux imports :

```ts
import { createAccount, prisma } from './accounts';
```

et `encodeHello` à l'import depuis `@shared/protocol`.

2. Dans le `beforeEach`, avant `buildServer`, ajouter :

```ts
  await prisma.account.deleteMany();
```

3. Dans `connect`, juste après `const ws = new WebSocket(...)` et `ws.binaryType = 'arraybuffer'`,
   et **avant** le `await waitFor(... 'WELCOME' ...)`, insérer :

```ts
  // Depuis l'etape 7a, toute socket de jeu presente son jeton AVANT d'obtenir
  // un slot : chaque client de ce harnais a donc son propre compte.
  const { token } = await createAccount();
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.send(encodeHello(token));
```

⚠️ **Le `ws.on('message', …)` doit être installé AVANT le `ws.send(encodeHello(...))`**, sinon le
`WELCOME` arrive avant que le harnais n'écoute. Lire chaque `connect` et placer l'insertion en
conséquence — les quatre fichiers ne sont pas identiques.

⚠️ `elements-5c.integration.test.ts` crée **trois salons** et douze clients : vérifier qu'aucun ne
réutilise un jeton, sans quoi deux slots partageraient un compte et le test de crédit de la tâche 6
mentirait.

- [ ] **Étape 6 : lancer les quatre fichiers, un par un**

```bash
cd back
npx vitest run src/draft.integration.test.ts
npx vitest run src/elements.integration.test.ts
npx vitest run src/portal.integration.test.ts
npx vitest run src/elements-5c.integration.test.ts
```

Attendu : tous verts. `elements-5c` coûte ~60 s ; c'est normal.

- [ ] **Étape 7 : lint, typecheck, commit**

```bash
cd .. && npm run lint && npm run typecheck
git add back/src/server.ts back/src/handshake.integration.test.ts \
        back/src/draft.integration.test.ts back/src/elements.integration.test.ts \
        back/src/portal.integration.test.ts back/src/elements-5c.integration.test.ts
git commit -m "feat(back): le slot n existe qu apres un HELLO reconnu

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 6 : le crédit, au drain de `RUN_OVER`

**Files :**
- Modify: `back/src/server.ts` (`Session#broadcast`)
- Create: `back/src/credit.integration.test.ts`

**Interfaces :**
- Consumes: `Session#accountIdOf` (tâche 5), `creditAccounts` et `goldOf` (tâche 2).
- Produces: rien de public ; un effet de bord au drain.

- [ ] **Étape 1 : écrire les tests qui échouent**

`back/src/credit.integration.test.ts`. Reprendre le harnais de `portal.integration.test.ts`
(quatre sockets, `HELLO`, `app.rooms`) et ajouter :

```ts
describe('etape 7a tache 6 : la fin de run credite les comptes connectes', () => {
  /**
   * Le coeur du §4.1 : **la totalite de la cagnotte, a CHACUN**. La mutation
   * « part egale » (`gold / clients.size`) doit rougir ici, et elle rougit sur
   * les quatre comptes a la fois.
   */
  it('quatre joueurs, une extraction : quatre comptes credites de la cagnotte ENTIERE', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);

    // La cagnotte, posee a la main : ce test mesure le CREDIT, pas la facon de
    // gagner de l'or (c'est l'etape 6a qui la couvre).
    room.debugSetGold(1200);
    await voteExtraction(clients, room);

    for (const c of clients) {
      const compteId = c.accountId;
      expect(await goldOf(compteId)).toBe(1200n);
    }
  });

  /**
   * §4.3 : extraction ET wipe passent par le MEME chemin. L'assertion est
   * DERIVEE de `WIPE_GOLD_KEPT`, jamais un `0` ecrit en dur — doctrine du
   * docbloc de `REACTION_DAMAGE`. Le jour ou la constante passe a 0.15, ce
   * test suit sans etre touche.
   */
  it('un wipe credite gold x WIPE_GOLD_KEPT, par le meme chemin', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);

    room.debugSetGold(1000);
    await tueToutLeMonde(clients, room);

    const attendu = BigInt(Math.round(1000 * WIPE_GOLD_KEPT));
    for (const c of clients) {
      expect(await goldOf(c.accountId)).toBe(attendu);
    }
  });

  it('un joueur deconnecte avant la fin de run n est pas credite', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);
    const parti = clients[3];
    if (!parti) {
      throw new Error('quatre clients attendus');
    }
    parti.ws.close();
    await attendre(() => (room.playerCount === 3 ? true : null), 'depart', 3000);

    room.debugSetGold(400);
    await voteExtraction(clients.slice(0, 3), room);

    expect(await goldOf(parti.accountId)).toBe(0n);
    for (const c of clients.slice(0, 3)) {
      expect(await goldOf(c.accountId)).toBe(400n);
    }
  });

  /**
   * Review Focus n°5 : deux salons qui finissent sur le MEME compte. Un
   * lire-modifier-ecrire perdrait l'un des deux credits, et le symptome serait
   * de l'or qui disparait sans trace. L'increment atomique rend la somme.
   */
  it('deux salons qui finissent sur le meme compte donnent la SOMME', async () => {
    const { id, token } = await createAccount();

    for (const montant of [300, 500]) {
      const code = await createRoomCode();
      const room = app.rooms.get(code);
      if (!room) {
        throw new Error('salon introuvable');
      }
      const c = await connectAvecJeton(code, token);
      room.debugSetGold(montant);
      await voteExtraction([c], room);
    }

    expect(await goldOf(id)).toBe(800n);
  });

  /**
   * §4.4 : **un echec de credit ne doit pas emporter le salon.** Le plafond
   * assume est « trois tentatives puis un journal » ; ce qui ne serait PAS
   * assumable, c'est qu'une base injoignable fasse tomber la boucle de jeu et
   * prive les joueurs de leur fin de run. La base est rendue injoignable pour
   * de vrai — aucun mock — en deconnectant le client Prisma.
   */
  it('une base injoignable au credit ne tue ni la run ni le salon', async () => {
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const clients = await quatreClients(code);
    room.debugSetGold(500);

    await prisma.$disconnect();
    try {
      await voteExtraction(clients, room);
      // La fin de run est bien parvenue aux clients : c'est ca qui compte.
      for (const c of clients) {
        expect(c.received.some((m) => m.type === MSG.RUN_OVER)).toBe(true);
      }
      // Et les sockets sont toujours ouvertes : rien n'est tombe.
      for (const c of clients) {
        expect(c.ws.readyState).toBe(WebSocket.OPEN);
      }
    } finally {
      await prisma.$connect();
    }
  });

  /**
   * Le protocole gagne UN type de message, envoye UNE fois par connexion, et
   * zero octet par tick. Mesure au niveau socket, comme aux etapes 5b et 5c.
   */
  it('aucun octet de plus par tick : SNAPSHOT, ZONE et REACTION ne bougent pas', async () => {
    const code = await createRoomCode();
    const clients = await quatreClients(code);
    await attendreQuelquesTicks(clients);

    const snap = tailleParType(clients[0], MSG.SNAPSHOT);
    expect(new Set(snap).size).toBe(1);
    expect(snap[0]).toBe(SNAPSHOT_HEADER_BYTES + 4 * SNAPSHOT_PLAYER_BYTES);
    expect(SNAPSHOT_HEADER_BYTES).toBe(22);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(9);
    expect(ZONE_BYTES).toBe(11);
    expect(REACTION_BYTES).toBe(11);
  });
});
```

⚠️ **`room.debugSetGold`, `voteExtraction`, `tueToutLeMonde`, `connectAvecJeton`,
`attendreQuelquesTicks` et `tailleParType` n'existent pas.** Les cinq derniers sont des
**helpers locaux à ce fichier** : les écrire en reprenant `portal.integration.test.ts`, qui sait
déjà faire voter quatre sockets et lire un `PORTAL_RESULT`. `Client` gagne un champ
`accountId: string`, rempli par `connect`.

`debugSetGold` est le seul ajout à `Room` : l'écrire comme

```ts
  /**
   * Pose la cagnotte, pour les tests du credit UNIQUEMENT.
   *
   * ⚠️ **Nomme `debug` pour que personne ne s'en serve en production.** La
   * facon de GAGNER de l'or est couverte par l'etape 6a ; ce qui se teste ici
   * est le transfert vers le compte, et faire jouer vingt minutes pour poser
   * une cagnotte rendrait le test inutilisable.
   */
  debugSetGold(gold: number): void {
    this.#gold = gold;
  }
```

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd back && npx vitest run src/credit.integration.test.ts
```

Attendu : ÉCHEC — les soldes valent tous `0n`.

⚠️ **Le test « base injoignable » peut passer d'emblée** (rien ne crédite encore, donc rien ne
lève). C'est normal : il ne garde pas une nouveauté, il **empêche** une régression que l'étape 3
va rendre possible. Le relancer après l'étape 3 est ce qui lui donne son sens.

- [ ] **Étape 3 : écrire l'implémentation**

Dans `back/src/server.ts`, à l'endroit du drain (`const runOver = this.room.drainRunOver();`),
remplacer le bloc par :

```ts
    const runOver = this.room.drainRunOver();
    if (runOver) {
      this.#send(encodeRunOver(runOver.tick, runOver.survivedTicks, runOver.level, runOver.kills));
      // ⚠️ **LE seul endroit qui verse l'or sur les comptes**, et il est
      // atteint exactement une fois par run — par DEUX invariants en serie :
      // le garde de tete de `Room#step` rend un second `#endRun` inatteignable,
      // et `drainRunOver` ANNULE l'evenement en le rendant. L'idempotence ne
      // demande donc ni journal ni cle.
      //
      // ⚠️ **Pas dans `Room`.** `Room` est de la logique de jeu sans aucune
      // I/O : y glisser un appel Prisma la rendrait intestable sans base.
      void this.#creditAccounts();
    }
```

Et la méthode, dans `Session` :

```ts
  /**
   * Verse la cagnotte sur le compte de CHAQUE joueur encore connecte — la
   * TOTALITE a chacun, pas une part (§4.1 de la spec).
   *
   * Diviser par le nombre de joueurs ferait toucher a chacun MOINS qu'en solo
   * sur la part de palier, qui ne passe pas a l'echelle : le §8.1 de
   * l'orientation interdit de punir le regroupement.
   *
   * ⚠️ **Trois tentatives, puis un journal, et c'est un plafond assume.** La
   * sortie propre est une table d'« outbox » ecrite dans la meme transaction
   * que la fin de run et rejouee jusqu'a succes. Elle n'est pas de cette etape
   * (§4.4 de la spec) ; si une perte reelle est constatee, c'est la sortie.
   */
  async #creditAccounts(): Promise<void> {
    const montant = BigInt(this.room.gold);
    if (montant === 0n) {
      return;
    }
    const comptes = [...this.#clients.keys()]
      .map((id) => this.#accounts.get(id))
      .filter((v): v is string => v !== undefined);
    if (comptes.length === 0) {
      return;
    }
    for (let essai = 1; essai <= 3; essai++) {
      try {
        await creditAccounts(comptes, montant);
        return;
      } catch (err) {
        if (essai === 3) {
          console.error(
            `[credit] ECHEC definitif salon=${this.code} montant=${montant} comptes=${comptes.join(',')}`,
            err,
          );
          return;
        }
      }
    }
  }
```

Ajouter `creditAccounts` à l'import depuis `./accounts`.

⚠️ **`montant === 0n` rend tôt**, donc le test du wipe à `WIPE_GOLD_KEPT = 0` passe par le
chemin sans rien écrire — et c'est correct : `0n` crédité ou rien crédité donnent le même solde.
Le jour où la constante vaut `0.15`, le même code écrit sans être touché.

- [ ] **Étape 4 : lancer les tests pour vérifier qu'ils passent**

```bash
cd back && npx vitest run src/credit.integration.test.ts
```

Attendu : 7 tests verts.

- [ ] **Étape 5 : lint, typecheck, commit**

```bash
cd .. && npm run lint && npm run typecheck
git add back/src/server.ts back/src/room.ts back/src/credit.integration.test.ts
git commit -m "feat(back): la fin de run verse la cagnotte entiere a chaque compte

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 7 : le front — frapper le jeton, l'envoyer, montrer le solde

**Files :**
- Modify: `front/index.html`
- Modify: `front/src/main.ts`
- Modify: `front/src/net/client.ts`
- Create: `front/src/net/account.ts`
- Create: `front/src/net/account.test.ts`

**Interfaces :**
- Consumes: `encodeHello`, `TOKEN_BYTES` (tâche 1) ; les deux routes (tâche 4).
- Produces: depuis `front/src/net/account.ts` —
  - `tokenText(storage: Pick<Storage, 'getItem' | 'setItem'>, mint: () => Promise<string>): Promise<string>`
  - `tokenBytes(text: string): Uint8Array`
  - `STORAGE_KEY = 'tarnok.account.token'`

- [ ] **Étape 1 : écrire les tests qui échouent**

`front/src/net/account.test.ts` :

```ts
import { TOKEN_BYTES } from '@shared/protocol';
import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEY, tokenBytes, tokenText } from './account';

function fausseStorage(initial?: string): Pick<Storage, 'getItem' | 'setItem'> & {
  lu: Record<string, string>;
} {
  const lu: Record<string, string> = initial ? { [STORAGE_KEY]: initial } : {};
  return {
    lu,
    getItem: (k: string) => lu[k] ?? null,
    setItem: (k: string, v: string) => {
      lu[k] = v;
    },
  };
}

const JETON = 'A'.repeat(43);

describe('etape 7a tache 7 : le jeton du client', () => {
  it('frappe un jeton au PREMIER chargement, et le garde', async () => {
    const s = fausseStorage();
    const mint = vi.fn(async () => JETON);
    expect(await tokenText(s, mint)).toBe(JETON);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(s.lu[STORAGE_KEY]).toBe(JETON);
  });

  /**
   * ⚠️ **Le coeur du livrable : on ne frappe PAS un second compte.** Sans ce
   * test, un bug qui reappellerait `POST /accounts` a chaque chargement
   * donnerait un compte neuf — et un solde a zero — a chaque visite. « L'or
   * survit » serait faux, et de la facon la plus silencieuse possible.
   */
  it('ne frappe RIEN si un jeton est deja la', async () => {
    const s = fausseStorage(JETON);
    const mint = vi.fn(async () => 'B'.repeat(43));
    expect(await tokenText(s, mint)).toBe(JETON);
    expect(mint).not.toHaveBeenCalled();
  });

  it('un jeton stocke mal forme est remplace plutot que de tout casser', async () => {
    const s = fausseStorage('pas-un-jeton');
    const mint = vi.fn(async () => JETON);
    expect(await tokenText(s, mint)).toBe(JETON);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('le texte se convertit en TOKEN_BYTES octets', () => {
    expect(tokenBytes(JETON).length).toBe(TOKEN_BYTES);
  });

  it('un texte de mauvaise longueur leve', () => {
    expect(() => tokenBytes('court')).toThrow();
  });
});
```

- [ ] **Étape 2 : lancer les tests pour vérifier qu'ils échouent**

```bash
cd front && npx vitest run src/net/account.test.ts
```

Attendu : ÉCHEC — `./account` n'existe pas.

- [ ] **Étape 3 : écrire `front/src/net/account.ts`**

```ts
import { TOKEN_BYTES } from '@shared/protocol';

/** La cle du `localStorage` qui porte le jeton de compte. */
export const STORAGE_KEY = 'tarnok.account.token';

/** Longueur du jeton en base64url : 32 octets -> 43 caracteres. */
const TEXT_LENGTH = 43;

function bienForme(text: string | null): text is string {
  return text !== null && /^[A-Za-z0-9_-]{43}$/.test(text);
}

/**
 * Le jeton de ce navigateur, frappe au besoin.
 *
 * ⚠️ **`mint` n'est appele QUE si le stockage n'en porte pas deja un de bonne
 * forme.** Le rappeler a chaque chargement donnerait un compte neuf — donc un
 * solde a zero — a chaque visite, et « l'or survit a la fermeture du
 * navigateur » serait faux de la facon la plus silencieuse possible.
 *
 * `storage` est injecte plutot que lu globalement : c'est ce qui rend cette
 * fonction testable sans navigateur.
 */
export async function tokenText(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  mint: () => Promise<string>,
): Promise<string> {
  const existant = storage.getItem(STORAGE_KEY);
  if (bienForme(existant)) {
    return existant;
  }
  const neuf = await mint();
  storage.setItem(STORAGE_KEY, neuf);
  return neuf;
}

/** Le jeton en octets, pour `encodeHello`. Leve si le texte est mal forme. */
export function tokenBytes(text: string): Uint8Array {
  if (text.length !== TEXT_LENGTH) {
    throw new Error(`jeton de ${text.length} caracteres, ${TEXT_LENGTH} attendus`);
  }
  const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  if (out.length !== TOKEN_BYTES) {
    throw new Error(`jeton de ${out.length} octets, ${TOKEN_BYTES} attendus`);
  }
  return out;
}
```

- [ ] **Étape 4 : lancer les tests pour vérifier qu'ils passent**

```bash
cd front && npx vitest run src/net/account.test.ts
```

Attendu : 5 tests verts.

- [ ] **Étape 5 : envoyer le `HELLO` à l'ouverture de la socket**

Le site exact est `front/src/net/client.ts:1384`, dans `GameClient#connect()` :

```ts
    ws.addEventListener('open', () => {
      this.#setStatus('open');
```

**Le jeton arrive par un SEPTIÈME paramètre OPTIONNEL du constructeur.** Le constructeur de
`GameClient` en a déjà six, dont quatre optionnels à valeur par défaut ; `client.test.ts` compte
**40 sites de construction**. Rendre le jeton obligatoire imposerait d'éditer ces 40 sites pour une
valeur dont aucun de ces tests ne se sert.

⚠️ **Et ce n'est PAS le piège « un chemin qui n'existe que pour les tests »**, celui que la tâche 5
refuse explicitement côté serveur. La différence est l'autorité : **le client n'en a aucune.** Le
serveur refuse toute socket sans `HELLO` valide, et c'est testé (tâche 5). Un client qui omet le
jeton se fait donc simplement fermer la socket — il n'existe aucun second chemin **serveur**, et
c'est là que vit le danger. Les 40 tests du front pilotent une fausse socket et ne parlent à aucun
serveur réel.

Ajouter, après le dernier paramètre du constructeur :

```ts
    /**
     * Le jeton de compte, en octets. Envoye comme PREMIER message de la socket
     * (`MSG.HELLO`) : le serveur n'attribue aucun slot avant de l'avoir
     * reconnu (§2.2 de la spec de l'etape 7a).
     *
     * ⚠️ **Optionnel ici, obligatoire cote SERVEUR.** Ce client n'a aucune
     * autorite : une socket sans `HELLO` valide est fermee par le serveur.
     * L'optionalite n'ouvre donc aucun chemin de jeu, elle evite seulement
     * d'imposer une valeur inutile aux quarante constructions de
     * `client.test.ts`.
     */
    private readonly accountToken: Uint8Array | null = null,
```

Et, dans le gestionnaire `open`, **en toute première ligne du corps** :

```ts
    ws.addEventListener('open', () => {
      // Le PREMIER octet que ce client envoie, toujours — avant le moindre
      // INPUT, parce que le serveur n'attribue pas de slot avant.
      if (this.accountToken) {
        ws.send(encodeHello(this.accountToken));
      }
      this.#setStatus('open');
```

Ajouter `encodeHello` à l'import depuis `@shared/protocol`.

⚠️ **`setInterval` d'envoi d'`INPUT` reste APRÈS le `HELLO`** dans ce même gestionnaire : l'ordre
des lignes est l'ordre des octets sur le fil, et un `INPUT` arrivé avant le `HELLO` serait
interprété comme un premier message invalide et fermerait la socket.

- [ ] **Étape 5 bis : le test qui prouve que l'URL ne porte rien**

Dans `front/src/ui/config.test.ts` (le créer s'il n'existe pas) :

```ts
import { describe, expect, it } from 'vitest';

import { gameSocketUrl } from './config';

describe('etape 7a : l URL de jeu ne porte aucun secret', () => {
  /**
   * §2.1 de la spec : le jeton ne passe JAMAIS par une URL — une URL atterrit
   * dans les journaux du reverse proxy, dans `Referer` et dans l'historique du
   * navigateur. Ce test epingle la seule chaine de requete admise.
   */
  it('ne contient que le code de salon, et rien d autre', () => {
    const url = new URL(gameSocketUrl('ABCD'));
    expect([...url.searchParams.keys()]).toEqual(['room']);
    expect(url.searchParams.get('room')).toBe('ABCD');
    expect(url.toString()).not.toMatch(/token/i);
  });
});
```

- [ ] **Étape 6 : le solde sur l'écran d'accueil**

Dans `front/index.html`, à l'intérieur du `ts-panel` du `#lobby`, après le paragraphe de
présentation :

```html
            <p class="text-center text-sm">
              Or : <span id="account-gold" class="font-bold">…</span>
            </p>
```

Dans `front/src/main.ts`, près des autres `el(...)` :

```ts
const goldLine = el('account-gold');

/**
 * Frappe le compte si besoin, puis affiche son solde.
 *
 * ⚠️ **Un echec ne doit pas empecher de jouer.** Le solde est un affichage ;
 * si la base est injoignable, on joue sans le voir plutot que de bloquer
 * l'ecran d'accueil.
 */
async function chargeSolde(): Promise<string> {
  const texte = await tokenText(window.localStorage, async () => {
    const res = await fetch(`${API_URL}/accounts`, { method: 'POST' });
    if (!res.ok) {
      throw new Error(`POST /accounts : ${res.status}`);
    }
    return (await res.json()).token as string;
  });
  try {
    const res = await fetch(`${API_URL}/accounts/me`, {
      headers: { Authorization: `Bearer ${texte}` },
    });
    goldLine.textContent = res.ok ? (await res.json()).gold : '—';
  } catch {
    goldLine.textContent = '—';
  }
  return texte;
}
```

Appeler `chargeSolde()` au démarrage, garder le jeton rendu, et le passer à la connexion de jeu.

- [ ] **Étape 7 : vérifier à la main**

```bash
# Dans trois terminaux : la base, le back, le front.
npm run dev -w back
npm run dev -w front
```

Ouvrir `http://localhost:5173`, vérifier que « Or : 0 » s'affiche, créer un salon, jouer,
s'extraire, **fermer l'onglet**, revenir — le solde doit avoir monté.

- [ ] **Étape 8 : lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add front/index.html front/src/main.ts front/src/net/client.ts \
        front/src/net/account.ts front/src/net/account.test.ts \
        front/src/ui/config.test.ts
git commit -m "feat(front): frappe le compte, presente le jeton, affiche le solde

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 8 : le livrable — l'or survit, littéralement

**Files :**
- Create: `back/src/or-survit.integration.test.ts`

**Interfaces :**
- Consumes: tout ce qui précède.
- Produces: rien.

- [ ] **Étape 1 : écrire le test**

La phrase du §13, rendue exécutable : **une seconde connexion, avec le même jeton, voit le
nouveau solde.**

```ts
describe('etape 7a : le livrable du §13 — l or survit a la fermeture du navigateur', () => {
  /**
   * ⚠️ **La seconde connexion est tout le test.** Verifier que la base contient
   * 1 200 prouverait que le serveur a ecrit ; verifier qu'un client qui
   * REVIENT lit 1 200 prouve que l'or survit. C'est la difference entre tester
   * l'implementation et tester le livrable.
   */
  it('un joueur s extrait, ferme tout, revient, et retrouve son or', async () => {
    // 1. Un compte, comme le ferait un premier chargement du navigateur.
    const frappe = await app.inject({ method: 'POST', url: '/accounts' });
    const { token } = frappe.json<{ token: string }>();

    const avant = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(avant.json<{ gold: string }>().gold).toBe('0');

    // 2. Une run, et une extraction.
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, token);
    room.debugSetGold(1200);
    await voteExtraction([client], room);

    // 3. « Fermer le navigateur » : la socket part, et plus rien ne la relie au
    //    serveur. Seul le jeton subsiste — comme dans un localStorage.
    client.ws.close();
    await attendre(() => (room.playerCount === 0 ? true : null), 'fermeture', 3000);

    // 4. Revenir. Une requete neuve, aucun etat partage avec la precedente.
    const apres = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(apres.statusCode).toBe(200);
    expect(apres.json<{ gold: string }>().gold).toBe('1200');
  });

  it('et un AUTRE jeton ne voit rien de cet or', async () => {
    const mien = (await app.inject({ method: 'POST', url: '/accounts' })).json<{ token: string }>();
    const autre = (await app.inject({ method: 'POST', url: '/accounts' })).json<{
      token: string;
    }>();

    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, mien.token);
    room.debugSetGold(700);
    await voteExtraction([client], room);

    const vu = await app.inject({
      method: 'GET',
      url: '/accounts/me',
      headers: { authorization: `Bearer ${autre.token}` },
    });
    expect(vu.json<{ gold: string }>().gold).toBe('0');
  });
});
```

Reprendre le harnais et les helpers de `credit.integration.test.ts` (`createRoomCode`,
`connectAvecJeton`, `voteExtraction`, `attendre`).

- [ ] **Étape 2 : lancer, vérifier que ça passe**

```bash
cd back && npx vitest run src/or-survit.integration.test.ts
```

Attendu : 2 tests verts.

- [ ] **Étape 3 : la campagne de mutation**

⚠️ **Après le commit** — la campagne restaure par `git checkout` et effacerait tout travail non
committé.

```bash
cd .. && npm run lint && npm run typecheck
git add back/src/or-survit.integration.test.ts
git commit -m "test(back): l or survit a la fermeture du navigateur

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

Puis, pour **chacune** des mutations ci-dessous : l'appliquer, lancer le fichier entier
(`npx vitest run src/<fichier>.test.ts` depuis `back/`, **jamais** avec un filtre `-t`), noter le
compte de rouges, et restaurer par `git checkout <fichier>`.

**Appliquer la mutation, ne pas la raisonner.**

| Mutation | Fichier | Doit faire rougir |
| --- | --- | --- |
| `creditAccounts` divise : `increment: amount / BigInt(accountIds.length)` | `back/src/accounts.ts` | tâche 6, « cagnotte ENTIÈRE » |
| `creditAccounts` lit puis écrit au lieu d'incrémenter | `back/src/accounts.ts` | tâche 6, « deux salons donnent la SOMME » |
| `hashToken` rend `tokenToText(token)` (stockage en clair) | `back/src/accounts.ts` | tâche 2, « la base stocke le HACHÉ » |
| La colonne `gold` passe de `BigInt` à `Int` | `back/prisma/schema.prisma` | tâche 2, « au-delà d'Int32 » |
| `tokenText` appelle toujours `mint()` | `front/src/net/account.ts` | tâche 7, « ne frappe RIEN si un jeton est déjà là » |
| `add` attribue le slot sans attendre le `HELLO` | `back/src/server.ts` | tâche 5, « aucun WELCOME tant que… » |
| `accountIdFromHeader` rend un id fixe au lieu de `null` | `back/src/server.ts` | tâche 4, « 401 » |
| `GET /accounts/me` rend `gold` en nombre et non en texte | `back/src/server.ts` | tâche 4, « se sérialise en TEXTE » |

Une mutation qui reste verte est un trou : **le dire**, ajouter l'assertion qui manque, et
re-committer.

---

## Tâche 9 : résultats, README, et le portique

**Files :**
- Create: `docs/plans/2026-10-10-etape-7a-resultats.md`
- Modify: `README.md`

- [ ] **Étape 1 : le portique complet, lancé SEUL**

⚠️ **Rien d'autre en vol** — ni banc, ni sous-agent, ni seconde suite. Trois chiffres faux ont été
payés à l'étape 5c pour avoir ignoré ça.

```bash
npm run lint && npm run typecheck && npm test
```

- [ ] **Étape 2 : écrire le document de résultats**

Mêmes sections que `docs/plans/2026-09-26-etape-5c-resultats.md` : le livrable, ce que les
décisions ont coûté, les écarts assumés, et une section **« vérification manuelle » laissée
ouverte** pour la run de l'auteur.

Y inscrire au minimum :
- le nombre de commits et de tests ;
- les huit mutations et leur résultat ;
- les écarts assumés du §7 de la spec, repris tels quels ;
- **le fait que trois playtests sont dus** (5b §4, 6a §3, 5c §12) et que 7a en ajoute un quatrième.

- [ ] **Étape 3 : la ligne de l'étape 7a au README**

Dans le tableau d'état, après la ligne `5c` :

```markdown
| 7a | Comptes anonymes, or persistant — **l'or survit à la fermeture du navigateur** | 📝 — [spec](docs/specs/2026-10-10-etape-7a-or-persistant.md) · [plan](docs/plans/2026-10-10-etape-7a-or-persistant.md) · [résultats](docs/plans/2026-10-10-etape-7a-resultats.md) |
```

- [ ] **Étape 4 : commit**

```bash
git add docs/plans/2026-10-10-etape-7a-resultats.md README.md
git commit -m "docs: resultats de l'etape 7a

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```
