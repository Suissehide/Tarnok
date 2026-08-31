import { archetypeOf, HEAVY_HP, STEP2_ARCHETYPES } from '@shared/archetypes';
import { MAX_ENTITIES, TICK_HZ } from '@shared/constants';
import { waveCountScale } from '@shared/paliers';
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

/**
 * ⚠️ **Ce bloc vit dans `back/` et pas dans `shared/paliers.test.ts`, contre la
 * liste de fichiers de la tache 1 du plan.** Il n'y a pas le choix :
 * `waveCountBounds` vit dans `back/src/wave-director.ts` et `shared/` ne peut
 * pas importer `back/` — la dependance ne va que dans un sens. Le mesurer
 * ailleurs qu'ici demanderait de deplacer `waveCountBounds` dans `shared/`,
 * ce que rien d'autre ne justifie.
 */
describe("la divergence du palier sur le nombre d'ennemis", () => {
  /**
   * Le compte le plus haut qu'une vague puisse valoir au palier `k` : la borne
   * haute en regime etabli, mise a l'echelle du palier.
   *
   * ⚠️ **`waveCountBounds` plafonne AVANT la mise a l'echelle**, donc son
   * `Math.min(..., MAX_ENTITIES)` n'est PAS ce qui protege ici. Ce qui protege,
   * c'est la marge entre le regime etabli (320) et `MAX_ENTITIES` (4000).
   */
  function plafondAuPalier(k: number): number {
    return waveCountBounds(1_000_000).max * waveCountScale(k);
  }

  /**
   * **Le verdict de l'etape 3 de la tache 1 : le plafond TIENT sur dix
   * paliers**, et il tient avec une marge d'un facteur douze au palier 0.
   * C'est une mesure, pas un espoir : le test la refait a chaque execution.
   */
  it('reste sous MAX_ENTITIES sur les dix paliers que le §7 de la spec fait simuler', () => {
    for (let k = 0; k <= 10; k++) {
      expect(plafondAuPalier(k)).toBeLessThan(MAX_ENTITIES);
    }
  });

  /**
   * ⚠️ **La moitie qui empeche le test precedent de passer pour rien.** Une
   * echelle nulle (`PALIER_COUNT_SCALE = 0`) le passerait aussi bien : la
   * pression doit MONTER, et le plafond doit finir par ceder — sinon la
   * formule est plate et la run n'a pas de fin (§3 de la spec, « les deux sens
   * comptent »).
   *
   * Le palier ou elle cede est **derive, jamais ecrit** : c'est un rapport
   * entre trois constantes qui bougeront toutes. On verifie seulement qu'il
   * existe, et qu'il est loin devant les dix paliers mesures.
   */
  it('finit malgre tout par ceder, et le dit : il existe un palier ou la vague deborde', () => {
    let premierDebordement = -1;
    for (let k = 0; k <= 1000 && premierDebordement < 0; k++) {
      if (plafondAuPalier(k) >= MAX_ENTITIES) {
        premierDebordement = k;
      }
    }

    process.stdout.write(
      `palier ou la borne haute d'une vague atteint MAX_ENTITIES : ${premierDebordement}\n`,
    );

    expect(premierDebordement).toBeGreaterThan(10);
    expect(premierDebordement).toBeLessThan(1000);
  });

  // ⚠️ **Ce qui se passe au-dela n'est pas un plantage, et personne ne l'ecrit
  // pour cette etape : `Horde.spawn` tronque deja** a `capacity` et
  // `MAX_PER_WAVE`, et `Room.step` compte la troncature dans
  // `RoomMetrics.truncatedSpawns`. Aucune garde nouvelle n'est donc ajoutee —
  // une seconde garde qui ne se declencherait jamais serait exactement le motif
  // « deux gardes qui se couvrent » rencontre quinze fois dans ce depot. Et le
  // plafond de `waveCountBounds` lui-meme est deja garde plus haut
  // (« reste bornee par MAX_ENTITIES, meme a un numero de vague extreme »).
});
