import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    /**
     * ⚠️ 60 s, contre 5 s par defaut — meme decision que `back/vitest.config.ts`,
     * prise pour la meme raison, et ce n'est PAS pour faire passer un test
     * fragile.
     *
     * Les 132 tests de ces deux fichiers coutent **4,71 s A EUX TOUS** quand la
     * machine est libre : aucun ne s'approche des 5 s. Mais dans la suite
     * COMPLETE, `orb-renderer.test.ts` (« pulse entre ce creux et l'opacite
     * pleine » : 2 000 appels a `draw` sur huit orbes) et `client.test.ts` (une
     * mort rejouee au-dela de `ROLLBACK_DEPTH_TICKS`) ont ete mesures a **13,1 s
     * et 13,3 s** — treize fois leur cout reel, par simple famine de CPU. Ils
     * ont rougi sur un delai depasse, pas sur une assertion.
     *
     * Les deux tests sont pourtant **entierement deterministes** : leur
     * parametre de temps est une variable de boucle, jamais une horloge. Un
     * delai qui depend de la charge de la machine transforme un test
     * deterministe en test intermittent — et **un test intermittent est pire
     * qu'un test absent : on finit par l'ignorer.**
     *
     * Le back a du relever ce delai DEUX fois (30 s, puis 60 s) pour ce motif
     * exact. Le front ne l'avait jamais fait ; l'etape 5c a rendu la suite assez
     * lourde pour que ca compte.
     */
    testTimeout: 60_000,
  },
});
