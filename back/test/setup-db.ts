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
