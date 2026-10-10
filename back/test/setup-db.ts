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
 * conditionnelle : seul le premier fichier d'un schema paie le CLI, les
 * autres paient deux requetes.
 *
 * ⚠️ **Le controle verifie « toutes les migrations du DOSSIER sont appliquees
 * dans le schema », pas « la table existe ».** La Postgres locale est un
 * conteneur longue duree : ses schemas `test_N` survivent entre deux runs. Le
 * jour ou une migration s'ajoute (l'etape 7b en ajoutera), un controle qui ne
 * verifierait que l'existence de la table verrait `Account`, sauterait
 * `migrate deploy`, et les tests tourneraient contre un schema perime — avec
 * une erreur Postgres (« column does not exist ») qui ne dirait rien du vrai
 * probleme. C'est le meme symptome que celui deja paye trois fois a l'etape
 * 5c, sous une autre forme.
 */
import { execSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
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
// habitude qu'on ne prend pas. Cette garde couvre les DEUX interpolations
// ci-dessous (le nom de schema dans la recherche de table, et dans la
// requete sur `_prisma_migrations`).
if (!/^test_\d+$/.test(schema)) {
  throw new Error(`nom de schema inattendu : ${schema}`);
}
const url = new URL(base);
url.searchParams.set('schema', schema);
process.env.DATABASE_URL = url.toString();

const migrationsDir = new URL('../prisma/migrations/', import.meta.url);
const surDisque = readdirSync(migrationsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

async function toutesLesMigrationsSontAppliquees(prisma: PrismaClient): Promise<boolean> {
  try {
    const appliquees = await prisma.$queryRawUnsafe<{ migration_name: string }[]>(
      `select migration_name from "${schema}"._prisma_migrations where finished_at is not null`,
    );
    const nomsAppliques = new Set(appliquees.map((m) => m.migration_name));
    return surDisque.every((nom) => nomsAppliques.has(nom));
  } catch {
    // ⚠️ **Toute erreur ici veut dire « il faut migrer », jamais l'inverse.**
    // Dans un schema neuf, `_prisma_migrations` n'existe pas encore : la
    // requete leve, et c'est attendu. Ce n'est PAS un `catch` defensif a
    // retirer — c'est le repli sur le chemin sur, qui ne coute qu'un `migrate
    // deploy` de trop, jamais un test qui tourne contre un schema perime.
    return false;
  }
}

const prisma = new PrismaClient();
if (!(await toutesLesMigrationsSontAppliquees(prisma))) {
  // `migrate deploy` cree le schema s'il manque et y joue les migrations. Il
  // est idempotent : un second appel ne fait rien — mais le CLI Node a un
  // cout de lancement que le controle ci-dessus evite aux fichiers suivants,
  // une fois le schema a jour.
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    stdio: 'pipe',
  });
}
await prisma.$disconnect();
