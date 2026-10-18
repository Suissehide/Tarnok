// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `?raw` de Vite : le vrai `index.html`, pas une fixture qui pourrait diverger
// de ce que `main.ts` cherche reellement.
import indexHtml from '../index.html?raw';

/**
 * `await stage.init()` est au niveau module : un rejet y arreterait le module
 * en silence (ni ecouteurs, ni boutique). `main.ts` ecrit donc le message dans
 * `#error` AVANT de relancer, pour que le joueur voie pourquoi au lieu d'un
 * ecran blanc.
 *
 * ⚠️ `main.ts` n'est pas importable en test (vraie `Application` Pixi) : ce
 * test remplace ENTIEREMENT `./render/stage` par un double avant l'import, si
 * bien que Pixi n'est jamais charge.
 */
const erreurInit = new Error('contexte webgl indisponible');

vi.mock('./render/stage', () => {
  class StageFactice {
    canvas = document.createElement('canvas');
    async init(): Promise<void> {
      throw erreurInit;
    }
  }
  return {
    Stage: StageFactice,
    hudInfo: vi.fn(),
    formatSummary: vi.fn(),
  };
});

describe('main.ts : un rejet de stage.init() ne laisse pas l ecran muet', () => {
  beforeEach(() => {
    document.body.innerHTML = indexHtml;
  });

  it('ecrit le message dans #error avant de relancer', async () => {
    await expect(import('./main')).rejects.toBe(erreurInit);

    const errorLine = document.getElementById('error');
    expect(errorLine?.textContent).toContain('Affichage impossible');
    expect(errorLine?.textContent).toContain(erreurInit.message);
  });
});
