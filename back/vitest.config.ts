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
    /**
     * ⚠️ Releve de 30 a 60 s : le scenario Z0 de `horde.replication.test.ts`
     * coute 16 s seul et 21 s dans son fichier, et **depassait les 30 s quand la
     * machine est chargee** — constate a l'etape 6a, ou il a fait rougir une
     * porte de commit sans rien dire du contrat qu'il garde.
     *
     * C'est la seconde fois que ce fichier frole son delai. Declarer son cout
     * reel vaut mieux que de le voir rougir au hasard.
     */
    testTimeout: 60_000,
    // ⚠️ `setupFiles`, pas `globalSetup` : il faut que ca tourne UNE FOIS PAR
    // WORKER (chacun a son schema), pas une fois pour toute la suite.
    setupFiles: ['./test/setup-db.ts'],
  },
});
