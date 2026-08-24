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
  },
});
