import { MAP_SIZE } from '@shared/constants';
import { Horde } from '@shared/horde';
import { FORMATION, type WaveOrder } from '@shared/waves';
import { describe, expect, it } from 'vitest';

import { BAND_COUNT, bandOf, DEPTH_BAND, sortByDepth } from './horde-renderer';

/**
 * Tache 15 : `bandOf` ne doit jamais pouvoir sortir de `[0, BAND_COUNT)`.
 *
 * `counts[band]` (dans `sortByDepth`) est une ecriture sur `Uint32Array` : un
 * indice hors bornes y est un NO-OP SILENCIEUX (ni exception, ni `undefined`
 * a l'ecriture) — la meme propriete du langage qui avait deja fait tomber la
 * tache 7 (troncature de capacite des projectiles). `bandOf` est la seule
 * garde entre une position hors carte et cette ecriture.
 */
describe('bandOf reste dans [0, BAND_COUNT) meme hors carte', () => {
  it('clampe les ordonnees negatives a la bande 0', () => {
    expect(bandOf(-1)).toBe(0);
    expect(bandOf(-8612)).toBe(0);
  });

  it('clampe les ordonnees au-dela de MAP_SIZE a la derniere bande', () => {
    expect(bandOf(MAP_SIZE)).toBe(BAND_COUNT - 1);
    expect(bandOf(MAP_SIZE + 1)).toBe(BAND_COUNT - 1);
    expect(bandOf(7665.8)).toBe(BAND_COUNT - 1);
  });

  it('laisse les ordonnees valides inchangees', () => {
    // ⚠️ Derive de `DEPTH_BAND`, jamais code en dur. La premiere version
    // affirmait `bandOf(63) === 0` et `bandOf(64) === 1` — vrai pour une bande
    // de 64 px, faux des qu'on la retrecit. Passer la bande de 64 a 2 px pour
    // corriger le clignotement a fait echouer ce test alors que `bandOf` etait
    // parfaitement correcte : le test gardait la valeur d'une constante, pas le
    // comportement de la fonction.
    expect(bandOf(0)).toBe(0);
    expect(bandOf(DEPTH_BAND - 1)).toBe(0);
    expect(bandOf(DEPTH_BAND)).toBe(1);
    expect(bandOf(DEPTH_BAND * 7 + 1)).toBe(7);
  });
});

/**
 * Le defaut reel n'est pas seulement "bandOf sort de la plage" : c'est ce que
 * ca fait au TAMPON `#sorted` en aval. Sans garde, plusieurs entites hors
 * carte s'ecrivent toutes au meme curseur invalide (`offsets[band] ?? 0`
 * retombe a 0 pour un indice jamais ecrit) et s'ecrasent mutuellement ; des
 * cases du tampon ne sont alors jamais reecrites et gardent leur contenu
 * perime de l'image precedente. Ce test observe directement cette propriete
 * plutot que la seule absence d'exception : les `visibleCount` premieres
 * cases de `sorted` doivent contenir une permutation EXACTE de `visible`,
 * jamais un doublon ni un residu d'un appel precedent.
 */
describe('sortByDepth ne corrompt pas #sorted avec des entites hors carte', () => {
  it('chaque case utilisee recoit une entite visible distincte, meme avec des y hors [0, MAP_SIZE]', () => {
    const N = 12;
    const horde = new Horde(N);
    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 3,
      archetype: 0,
      formation: FORMATION.SCATTER,
      anchorX: 3000,
      anchorY: 3000,
      count: N,
    };
    horde.spawn(order);

    // Quelques entites hors carte : ce que `shared/` devrait desormais
    // empecher, mais le renderer ne doit pas en dependre pour rester correct
    // (defense en profondeur, meme logique que la tache 7).
    horde.y[0] = -800;
    horde.y[3] = MAP_SIZE + 950;
    horde.y[7] = -8612;
    horde.y[9] = MAP_SIZE + 1665;

    const visible = new Int32Array(N);
    for (let i = 0; i < N; i++) {
      visible[i] = i;
    }

    const bandCounts = new Uint32Array(BAND_COUNT);
    const bandOffsets = new Uint32Array(BAND_COUNT + 1);
    // Rempli d'un residu reconnaissable, comme le tampon reel d'une image
    // precedente : une case jamais reecrite doit se trahir en gardant -1.
    const sorted = new Int32Array(N).fill(-1);

    sortByDepth(horde.y, visible, N, bandCounts, bandOffsets, sorted);

    const written = Array.from(sorted.slice(0, N));
    const asSet = new Set(written);

    // Aucun residu de -1, aucun doublon : exactement les N indices visibles,
    // chacun une fois.
    expect(asSet.size).toBe(N);
    for (let i = 0; i < N; i++) {
      expect(asSet.has(i)).toBe(true);
    }
    expect(written).not.toContain(-1);
  });
});
