import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Le back porte les tests de `shared/` : ils sont purs, ils n'ont besoin ni de
// DOM ni de navigateur, et les faire tourner deux fois n'apporterait rien.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '../shared/**/*.test.ts'],
    /**
     * ⚠️ 60 s, contre 5 s par defaut, et ce n'est PAS pour masquer un test
     * fragile : `horde.replication.test.ts` (convergence de simulations de
     * mille entites) et `draft.integration.test.ts` (quatre vraies sockets sur
     * une fenetre de draft entiere) sont lourds par construction, et le premier
     * depasse 30 s sur une machine chargee. Un test qui rougit au hasard finit
     * ignore.
     */
    testTimeout: 60_000,
    // ⚠️ `setupFiles`, pas `globalSetup` : chaque fichier peut tomber sur un
    // schema neuf (voir le docblock de setup-db.ts).
    setupFiles: ['./test/setup-db.ts'],
  },
});
