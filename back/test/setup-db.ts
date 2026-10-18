/**
 * ⚠️ **Un schema PostgreSQL par worker Vitest** (`test_${VITEST_WORKER_ID}`) :
 * les fichiers de test tournent en parallele, et deux fichiers qui
 * `deleteMany()` la meme table se pietineraient en rouges intermittents.
 *
 * ⚠️ **Ce fichier tourne UNE FOIS PAR FICHIER DE TEST, pas par worker**
 * (`isolate: true`, le defaut, rejoue `setupFiles`), y compris pour les tests
 * purs de `shared/`. D'ou la migration conditionnelle : seul le premier fichier
 * d'un schema paie le CLI, les autres paient deux requetes.
 *
 * ⚠️ **Le controle verifie que toutes les migrations du DOSSIER sont
 * appliquees, pas que la table existe** : les schemas `test_N` survivent entre
 * deux runs dans la Postgres locale, et une migration ajoutee ferait tourner
 * les tests contre un schema perime (« column does not exist »).
 *
 * ⚠️ **`DATABASE_URL` absente retombe sur l'URL locale du README** (`tarnok-db`,
 * `127.0.0.1:5442`) au lieu de lever : un `throw` ici ferait echouer chaque
 * fichier de test, purs compris. La CI pose `DATABASE_URL` explicitement. Le
 * repli est journalise, pour que personne ne croie tester contre sa propre
 * base.
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
   * ⚠️ **Une seule ligne pour tout le run.** Un drapeau en memoire de module
   * ne survivrait ni au rejeu par fichier ni au pool `forks`. `process.ppid`
   * est le pid du Vitest de CE run : une creation exclusive (`wx`) du fichier
   * sert de verrou atomique inter-processus, le premier gagne et journalise.
   * `process.stderr.write` et pas `console.error` : Vitest capture `console.*`
   * et ne le reaffiche pas sur un run vert.
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
// `schema` est interpole dans du SQL : meme venu de l'environnement, il ne
// passe que sous une forme connue.
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
    // ⚠️ **Toute erreur ici veut dire « il faut migrer ».** Dans un schema
    // neuf, `_prisma_migrations` n'existe pas : la requete leve, c'est attendu.
    // Au pire un `migrate deploy` de trop, jamais un schema perime.
    return false;
  }
}

const prisma = new PrismaClient();
if (!(await toutesLesMigrationsSontAppliquees(prisma))) {
  // `migrate deploy` cree le schema s'il manque et est idempotent ; le controle
  // ci-dessus n'evite que le cout de lancement du CLI.
  execSync('npx prisma migrate deploy', {
    cwd: new URL('..', import.meta.url).pathname,
    env: process.env,
    stdio: 'pipe',
  });
}
await prisma.$disconnect();
