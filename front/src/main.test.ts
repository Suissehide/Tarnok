// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// `?raw` de Vite, meme motif que `hud.test.ts`/`draft.test.ts`/`shop.test.ts` :
// le vrai `index.html`, pas une fixture qui pourrait diverger de ce que
// `main.ts` cherche reellement.
import indexHtml from '../index.html?raw';

/**
 * Amendement du controleur, point 2 (etape 7b, tache 8) : `await
 * stage.init()` est au niveau module, SANS garde. Un rejet y arretait le
 * module en silence — meme classe que le defaut I1 de l'etape 7a, dans ce
 * meme fichier — et plus personne n'enregistrait d'ecouteur ni n'affichait la
 * boutique. Le correctif ecrit le message dans `#error` AVANT de relancer
 * (`throw cause`) : sans canevas il n'y a pas de jeu, mais le joueur voit
 * pourquoi au lieu d'un ecran blanc muet.
 *
 * ⚠️ **`main.ts` dit de lui-meme qu'il n'est « pas importable en test »**,
 * parce qu'il instancie une vraie `Application` Pixi qu'aucun environnement
 * de test ne sait construire. Ce test ne contredit pas cette doctrine : il
 * remplace ENTIEREMENT `./render/stage` par un double avant l'import — la
 * vraie classe `Stage`, et donc Pixi, n'est jamais chargee. Seul le point
 * precis que l'amendement vise (le rejet de `stage.init`) est exerce.
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
