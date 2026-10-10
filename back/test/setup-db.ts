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
 *
 * ⚠️ **Ce fichier tourne UNE FOIS PAR FICHIER DE TEST, pas une fois par
 * worker.** `isolate: true` (le defaut de Vitest, pas change ici) donne a
 * chaque fichier un environnement neuf, qui rejoue `setupFiles` — mesure a la
 * ronde precedente : 38 fichiers de test dans ce depot, donc 38 passages ici
 * par run complet, y compris pour les tests purs de `shared/` qui ne touchent
 * jamais la base. C'est PRECISEMENT pourquoi la migration ci-dessous est
 * conditionnelle : seul le premier fichier d'un schema paie le CLI, les 37
 * autres paient une requete.
 */
import { execSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

const base = process.env.DATABASE_URL;
if (!base) {
  throw new Error(
    'DATABASE_URL manquante. Lance une Postgres (voir le README) et exporte la variable.',
  );
}

const worker = process.env.VITEST_WORKER_ID ?? '1';
const schema = `test_${worker}`;
// ⚠️ `schema` vient de VITEST_WORKER_ID, donc d'un environnement et pas d'un
// utilisateur — mais une interpolation non gardee dans du SQL est une
// habitude qu'on ne prend pas. Cette garde documente l'invariant.
if (!/^test_\d+$/.test(schema)) {
  throw new Error(`nom de schema inattendu : ${schema}`);
}
const url = new URL(base);
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();

const prisma = new PrismaClient();
const [row] = await prisma.$queryRawUnsafe<{ existe: boolean }[]>(
  `select to_regclass('"${schema}"."Account"') is not null as existe`,
);
if (!row?.existe) {
  // `migrate deploy` cree le schema s'il manque et y joue les migrations. Il
  // est idempotent : un second appel ne fait rien — mais le CLI Node a un
  // cout de lancement que la requete ci-dessus evite aux fichiers suivants.
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    stdio: 'pipe',
  });
}
await prisma.$disconnect();
