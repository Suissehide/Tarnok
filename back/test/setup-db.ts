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
 *
 * ⚠️ **`DATABASE_URL` absente retombe sur l'URL locale documentee, elle ne
 * leve plus.** `npm test` depuis la racine, dans un shell neuf, sans export
 * prealable, lancait ce fichier a chaque run de CHAQUE fichier de test (voir
 * plus haut) : un `throw` ici produisait donc un mur d'echecs identiques, y
 * compris sur les fichiers purs de `shared/` qui n'ont jamais eu besoin d'une
 * base. Le defaut est sans danger a deux titres :
 * - **la CI pose `DATABASE_URL` explicitement** (voir `.github/workflows/ci.yml`),
 *   donc ce defaut ne s'y applique jamais ;
 * - **en local, la commande `docker run` du README cree EXACTEMENT ce
 *   conteneur et cette URL** (`tarnok-db`, `127.0.0.1:5442`), donc le defaut
 *   est juste par construction, pas une devinette.
 * La ligne journalisee plus bas est ce qui rend ce defaut acceptable plutot
 * que sournois : sans elle, quelqu'un dont la Postgres locale ecoute
 * ailleurs croirait tester contre sa propre base alors qu'il tape dans le
 * vide (ou dans celle d'un autre).
 */
import { execSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';

const URL_LOCALE_PAR_DEFAUT = 'postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok';

let base = process.env.DATABASE_URL;
if (!base) {
  base = URL_LOCALE_PAR_DEFAUT;
  process.env.DATABASE_URL = base;
  /**
   * ⚠️ **Une seule ligne pour tout le run, pas une par fichier de test.**
   * `setupFiles` rejoue ce module a chaque fichier (voir plus haut), et avec
   * le pool `forks` de Vitest chaque fichier peut en plus tomber sur un
   * processus different — un simple drapeau en memoire de module ne
   * survivrait ni a l'un ni a l'autre. `process.ppid` est stable : c'est le
   * pid du processus Vitest qui a lance tous les workers de CE run, et lui
   * seul change entre deux `npm test`. Une creation exclusive de fichier
   * (`wx`) dans le repertoire temporaire sert donc de verrou atomique
   * inter-processus : le premier fichier (de n'importe quel worker) a
   * l'ecrire gagne et journalise, tous les suivants echouent sur le fichier
   * deja present et se taisent. `process.stderr.write` (et pas
   * `console.error`) parce que Vitest capture `console.*` et ne le reaffiche
   * pas pour un run entierement vert avec le reporter par defaut — le
   * message serait ecrit mais jamais vu.
   */
  try {
    writeFileSync(join(tmpdir(), `tarnok-db-fallback-${process.ppid}.lock`), '', { flag: 'wx' });
    process.stderr.write(`DATABASE_URL absente, repli sur ${URL_LOCALE_PAR_DEFAUT}\n`);
  } catch {
    // Verrou deja pris par un autre fichier de ce meme run : deja journalise.
  }
}

const worker = process.env.VITEST_WORKER_ID ?? '1';
const schema = `test_${worker}`;
// ⚠️ `schema` vient de VITEST_WORKER_ID, donc d'un environnement et pas d'un
// utilisateur — mais une interpolation non gardee dans du SQL est une
// habitude qu'on ne prend pas. Cette garde garantit que `schema` ne peut
// valoir qu'une forme connue avant d'entrer dans une requete, quel que soit
// le nombre de requetes qui l'interpolent plus bas.
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
