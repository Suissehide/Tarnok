import { MAX_ENTITIES, TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { WaveDirector, waveCountBounds } from './wave-director';

describe('WaveDirector', () => {
  it('ne sort rien avant la premiere echeance', () => {
    const d = new WaveDirector(1234);

    expect(d.due(0, [3000], [3000])).toBeNull();
  });

  it('sort une vague a la cadence prevue', () => {
    const d = new WaveDirector(1234);
    let vagues = 0;
    for (let tick = 0; tick < TICK_HZ * 60; tick++) {
      if (d.due(tick, [3000], [3000])) {
        vagues++;
      }
    }

    // Une vague toutes les ~6 s sur une minute.
    expect(vagues).toBeGreaterThanOrEqual(8);
    expect(vagues).toBeLessThanOrEqual(12);
  });

  it('numerote les vagues sans jamais reutiliser un identifiant', () => {
    const d = new WaveDirector(1);
    const ids: number[] = [];
    for (let tick = 0; tick < TICK_HZ * 120; tick++) {
      const o = d.due(tick, [3000], [3000]);
      if (o) {
        ids.push(o.waveId);
      }
    }

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ancre la vague pres d un joueur, pas au hasard sur la carte', () => {
    const d = new WaveDirector(77);
    let order = null;
    for (let tick = 0; tick < TICK_HZ * 60 && !order; tick++) {
      order = d.due(tick, [1000], [1000]);
    }

    expect(order).not.toBeNull();
    expect(Math.hypot((order?.anchorX ?? 0) - 1000, (order?.anchorY ?? 0) - 1000)).toBeLessThan(
      2500,
    );
  });

  it('est deterministe pour une meme graine', () => {
    const a = new WaveDirector(5);
    const b = new WaveDirector(5);
    for (let tick = 0; tick < TICK_HZ * 30; tick++) {
      expect(a.due(tick, [3000], [3000])).toEqual(b.due(tick, [3000], [3000]));
    }
  });
});

describe('waveCountBounds', () => {
  /**
   * Forme, pas valeurs (tache 14) : les bornes ne peuvent jamais BAISSER
   * quand le numero de vague augmente, et l'intervalle reste coherent
   * (`min <= max`) a chaque etape. Verifie par mutation : une formule qui
   * ferait redescendre les bornes passe une vague donnee (par exemple une
   * interpolation qui deborde puis rebrousse) casserait cette boucle sans
   * qu'aucune valeur precise ne soit epinglee ici.
   */
  it('ne redescend jamais quand le numero de vague augmente', () => {
    let prevMin = Number.NEGATIVE_INFINITY;
    let prevMax = Number.NEGATIVE_INFINITY;
    for (let wave = 1; wave <= 60; wave++) {
      const { min, max } = waveCountBounds(wave);
      expect(min).toBeLessThanOrEqual(max);
      expect(min).toBeGreaterThanOrEqual(prevMin);
      expect(max).toBeGreaterThanOrEqual(prevMax);
      prevMin = min;
      prevMax = max;
    }
  });

  /**
   * La premiere vague doit rester strictement en dessous du regime etabli :
   * sans ca, un directeur qui rend les MEMES bornes a toutes les vagues (le
   * comportement de l'etape 2, plat) passerait le test de monotonie
   * ci-dessus — une suite constante ne redescend jamais non plus. C'est
   * cette comparaison, pas la precedente, qui verrouille qu'il y a bien une
   * MONTEE et pas un plateau depuis le debut.
   */
  it('la premiere vague est nettement plus petite que le regime etabli, loin dans la run', () => {
    const first = waveCountBounds(1);
    const late = waveCountBounds(1000);
    expect(first.min).toBeLessThan(late.min);
    expect(first.max).toBeLessThan(late.max);
  });

  /**
   * Bornee par `MAX_ENTITIES` (le plafond dur du salon) : meme a un numero
   * de vague extreme, jamais depassee. Verifie par mutation : retirer le
   * `Math.min(..., MAX_ENTITIES)` de `waveCountBounds` en gardant un plafond
   * de regime etabli superieur a `MAX_ENTITIES` ferait echouer cette
   * assertion — voir le rapport de la tache pour le releve de cette
   * mutation (le plafond de regime etabli actuel, 320, reste tres en
   * dessous de `MAX_ENTITIES` : c'est la garde qui compte ici, pas la valeur
   * de reglage).
   */
  it('reste bornee par MAX_ENTITIES, meme a un numero de vague extreme', () => {
    const { min, max } = waveCountBounds(1_000_000);
    expect(max).toBeLessThanOrEqual(MAX_ENTITIES);
    expect(min).toBeLessThanOrEqual(max);
  });
});
