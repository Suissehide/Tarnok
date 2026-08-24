import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type Plugin } from 'vite';

const TINYSWORDS_DIR = fileURLToPath(new URL('../assets/tinyswords', import.meta.url));

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
};

/**
 * Sert le pack Tiny Swords sous `/tinyswords/` en developpement.
 *
 * Les assets ne sont ni dans le depot (il est public, la licence Pixel Frog
 * interdit la redistribution) ni dans l'image Docker. En production, nginx
 * proxifie ce meme chemin vers MinIO — voir `deploy/nginx.conf.template`.
 *
 * Le front ne connait donc qu'un chemin same-origin, jamais une URL de bucket :
 * changer de stockage ne touche pas une ligne de CSS.
 */
function tinySwordsDevAssets(): Plugin {
  return {
    name: 'tarnok:tinyswords-dev-assets',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/tinyswords', (req, res, next) => {
        const rawPath = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
        // `normalize` puis rejet des `..` : sans ca, `/tinyswords/../../.env`
        // sort du dossier d'assets et sert n'importe quel fichier du disque.
        const relative = normalize(rawPath).replace(/^(\.\.[/\\])+/, '');
        if (relative.includes('..')) {
          res.statusCode = 403;
          res.end('chemin refuse');
          return;
        }

        const file = join(TINYSWORDS_DIR, relative);
        try {
          if (!statSync(file).isFile()) {
            next();
            return;
          }
        } catch {
          next();
          return;
        }

        res.setHeader(
          'Content-Type',
          MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        );
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), tinySwordsDevAssets()],
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: { port: 5173 },
});
