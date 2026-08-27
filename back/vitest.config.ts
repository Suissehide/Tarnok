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
     * ⚠️ 30 s, contre 5 s par defaut, et ce n'est PAS pour faire passer un test
     * fragile.
     *
     * Deux tests de ce depot sont lourds par construction et le resteront :
     *
     * - `horde.replication.test.ts` fait converger cinq simulations de mille
     *   entites, plusieurs fois — le livrable de l'etape 2. Mesure : ~5,7 s,
     *   soit **juste au-dessus** des 5 s par defaut. Il echouait donc environ
     *   une fois sur quatre, selon la charge de la machine, avec un message qui
     *   ne dit rien du contrat qu'il garde.
     * - `draft.integration.test.ts` fait jouer quatre vraies sockets pendant la
     *   fenetre de draft de 20 s — le livrable de l'etape 4.
     *
     * **Un test intermittent est pire qu'un test absent : on finit par
     * l'ignorer.** Declarer leur cout reel vaut mieux que de les voir rougir au
     * hasard, et mieux que de les alleger jusqu'a ce qu'ils ne prouvent plus
     * rien.
     */
    testTimeout: 30_000,
  },
});
