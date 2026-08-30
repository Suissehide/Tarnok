import { archetypeOf, HEAVY_HP, STEP2_ARCHETYPES } from '@shared/archetypes';
import { MAX_ENTITIES, TICK_HZ } from '@shared/constants';
import type { WaveOrder } from '@shared/waves';
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

describe('la part de pietaille lourde dans les vagues (etape 5a)', () => {
  /** Les `n` premiers ordres produits par une graine donnee. */
  function vagues(seed: number, n: number): WaveOrder[] {
    const d = new WaveDirector(seed);
    const out: WaveOrder[] = [];
    for (let tick = 0; out.length < n && tick < TICK_HZ * 6 * (n + 5); tick++) {
      const o = d.due(tick, [3000], [3000]);
      if (o) {
        out.push(o);
      }
    }
    return out;
  }

  const estLourde = (o: WaveOrder): boolean => archetypeOf(o.archetype).hp === HEAVY_HP;

  /**
   * ⚠️ **La fixture qui masque, prise a l'avance.** Si aucun archetype tirable
   * n'etait lourd, TOUTES les assertions de ce bloc passeraient sans rien
   * prouver : « aucune vague lourde avant la vague 6 » serait vrai parce
   * qu'aucune vague n'est lourde du tout, jamais.
   */
  it('a bien au moins un archetype lourd a tirer — sinon rien de ce qui suit ne prouve quoi que ce soit', () => {
    expect(STEP2_ARCHETYPES.some((id) => archetypeOf(id).hp === HEAVY_HP)).toBe(true);
  });

  it('ne lache aucune vague lourde avant la sixieme, sur toutes les graines essayees', () => {
    // Le joueur n'a que la dague avant son premier draft : une vague lourde
    // des le debut lui coute quatre fois plus de tirs et fait s'accumuler la
    // horde. Mesure : 3 runs solo perdues sur 20 avant le niveau 2 sans cette
    // borne. Voir `HEAVY_FIRST_WAVE`.
    for (let seed = 1; seed <= 40; seed++) {
      const cinq = vagues(seed, 5);
      expect(cinq).toHaveLength(5);
      expect(cinq.filter(estLourde)).toEqual([]);
    }
  });

  it('en lache ensuite, en minorite : ni jamais, ni tout le temps', () => {
    // Les deux mutations que cette assertion attrape : `HEAVY_WAVE_SHARE = 0`
    // (plus jamais de lourds, donc plus rien a marquer d'un element) et
    // `HEAVY_WAVE_SHARE = 1` (que des lourds, et le rythme de mise a mort
    // s'effondre). Balayage de graines plutot qu'une seule : la part est un
    // tirage, une graine unique pourrait n'en produire aucune par hasard.
    let lourdes = 0;
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const o of vagues(seed, 30).slice(5)) {
        total++;
        if (estLourde(o)) {
          lourdes++;
        }
      }
    }
    expect(total).toBeGreaterThan(500); // sanity : l'echantillon existe
    expect(lourdes).toBeGreaterThan(0);
    expect(lourdes / total).toBeLessThan(0.5);
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
