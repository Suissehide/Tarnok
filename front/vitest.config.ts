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
     * ⚠️ 60 s, contre 5 s par defaut — comme `back/vitest.config.ts`, et ce
     * n'est PAS pour faire passer un test fragile. Les tests lourds
     * (`orb-renderer.test.ts`, la mort rejouee de `client.test.ts`) sont
     * entierement deterministes mais, dans la suite complete, la famine de CPU
     * multiplie leur duree par plus de dix. Un delai qui depend de la charge
     * rend un test deterministe intermittent, et un test intermittent finit
     * ignore.
     */
    testTimeout: 60_000,
  },
});
