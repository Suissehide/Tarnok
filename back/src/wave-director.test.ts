import {
  archetypeOf,
  BOSS_ARCHETYPE,
  HEAVY_HP,
  LIGHT_HP,
  STEP2_ARCHETYPES,
} from '@shared/archetypes';
import { MAX_ENTITIES, MAX_PLAYERS, TICK_HZ, WAVES_PER_PALIER } from '@shared/constants';
import { bossHp, palierHp, waveCountScale } from '@shared/paliers';
import { FORMATION, type WaveOrder } from '@shared/waves';
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

  /**
   * ⚠️ **L'ancre EST le joueur depuis la tache 18 de l'etape 6a**, elle n'est
   * plus « pres de lui ». C'est `FORMATION.ENCIRCLE` qui pose la distance de
   * naissance, a `ENCIRCLE_RADIUS` tout autour — la vague n'arrive plus d'un
   * seul cote. L'assertion precedente (« a moins de 2 500 px ») ne verrouillait
   * pas ca : un ancrage decale de 1 800 px la passait tout aussi bien.
   */
  it('ancre la vague SUR un joueur, pas a cote', () => {
    const d = new WaveDirector(77);
    let order = null;
    for (let tick = 0; tick < TICK_HZ * 60 && !order; tick++) {
      order = d.due(tick, [1000], [1000]);
    }

    expect(order).not.toBeNull();
    expect(order?.anchorX).toBe(1000);
    expect(order?.anchorY).toBe(1000);
  });

  /**
   * ⚠️ **Ce n'est pas un gout de formation, c'est une COHERENCE.** Maintenant
   * que l'ancre est la position du joueur, toute formation qui n'encercle pas
   * ferait naitre la vague DANS ses jambes : `SCATTER` la seme dans un disque
   * de 900 px centre sur lui, `CLUSTER` lui pose cinq grappes sur la figure.
   * Le pool ne peut donc pas se rallonger sans que la question de l'ancre soit
   * reposee — c'est ce test qui la reposera.
   */
  it('fait encercler TOUTES ses vagues, boss compris', () => {
    const d = new WaveDirector(9);
    let vagues = 0;
    for (let tick = 0; tick < TICK_HZ * 300; tick++) {
      const o = d.due(tick, [3000, 2000], [3000, 4000]);
      if (o) {
        vagues++;
        expect(o.formation).toBe(FORMATION.ENCIRCLE);
      }
    }
    // La fixture produit bien ce qu'elle pretend mesurer : sans cette ligne,
    // zero vague emise passerait le test sans rien prouver.
    expect(vagues).toBeGreaterThan(40);
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

  /**
   * ⚠️ **L'AUTRE MOITIE DU §7 B, et elle a change de forme a la tache 3.** La
   * question du plan est *« la difficulte diverge-t-elle ? »*, et depuis que
   * `palierHp` exempte la chair a canon, la reponse ne se lit plus sur
   * `hpScale` seule : une vague legere de palier 10 pese exactement ce qu'elle
   * pesait au palier 0, a l'effectif pres. Ce qui monte, c'est le NOMBRE, la
   * part de lourds, et le boss.
   *
   * Le chiffre releve au banc `bench/boss.bench.ts` : la charge d'un palier
   * (4 vagues au mix reel + le boss) passe de 13 040 PV au palier 0 a 54 767 PV
   * au palier 10, soit **x4,2**. Ce test garde la FORME de cette courbe — elle
   * monte, et elle ne s'emballe pas — pas les nombres du releve.
   */
  it('fait monter la charge d un palier sans l emballer, sur dix paliers', () => {
    const moyen = (waveCountBounds(1_000_000).min + waveCountBounds(1_000_000).max) / 2;
    /** PV a abattre dans un palier `k` : 4 vagues au mix du generateur, plus le boss. */
    function chargeDuPalier(k: number): number {
      const effectif = moyen * waveCountScale(k);
      const parVague = effectif * (0.8 * palierHp(LIGHT_HP, k) + 0.2 * palierHp(HEAVY_HP, k));
      // ⚠️ **A effectif PLEIN, et il faut le dire** : depuis la tache 3 bis les
      // PV du boss dependent aussi du nombre de joueurs. La charge d'un palier
      // n'a donc plus de valeur unique — celle-ci est celle d'une equipe de
      // quatre, la seule que la porte du §7 ait mesuree.
      return WAVES_PER_PALIER * parVague + bossHp(k, MAX_PLAYERS);
    }

    for (let k = 0; k < 10; k++) {
      expect(chargeDuPalier(k + 1)).toBeGreaterThan(chargeDuPalier(k));
    }
    const facteur = chargeDuPalier(10) / chargeDuPalier(0);
    process.stdout.write(
      `charge d'un palier : x${facteur.toFixed(2)} entre le palier 0 et le 10\n`,
    );
    // ⚠️ **Les deux sens comptent** (§3 de la spec) : trop plate, la run n'a
    // pas de fin ; trop raide, le palier 8 est un mur. Une bande large, parce
    // que ce qui est garde ici est un ORDRE DE GRANDEUR — le reglage fin se
    // juge en jeu, pas ici.
    expect(facteur).toBeGreaterThan(2);
    expect(facteur).toBeLessThan(10);
  });

  /**
   * ⚠️ **« Si le palier 8 depasse `MAX_ENTITIES`, c'est `waveCountBounds` qui
   * plafonne — le dire, pas le decouvrir. »** Il ne le depasse pas : au palier
   * 10 la borne haute d'une vague vaut 800, soit 20 % de `MAX_ENTITIES`. Ce
   * test l'ecrit pour qu'on n'ait pas a le redecouvrir, et il PARLE, parce que
   * la valeur interessante est le rapport, pas le booleen.
   */
  it('dit ou en est le palier 8 vis-a-vis de MAX_ENTITIES', () => {
    const auPalier8 = plafondAuPalier(8);
    process.stdout.write(
      `palier 8 : borne haute d'une vague ${Math.round(auPalier8)} / MAX_ENTITIES ${MAX_ENTITIES} ` +
        `(${Math.round((100 * auPalier8) / MAX_ENTITIES)} %)\n`,
    );
    expect(auPalier8).toBeLessThan(MAX_ENTITIES / 2);
  });
});

describe('le palier structure la run (etape 6a, tache 2)', () => {
  /** Un ordre emis, avec le palier qui avait cours a cet instant. */
  interface Emission {
    order: WaveOrder;
    palier: number;
    boss: boolean;
  }

  /**
   * Fait tourner un directeur pendant `ticks` ticks et rend ses emissions.
   *
   * `tuerLeBoss` modelise l'equipe : `false`, personne ne tue le boss et le
   * palier ne bouge jamais ; `true`, il tombe a l'instant meme ou il apparait.
   * Les deux cas sont necessaires — voir les deux moities plus bas.
   */
  function emissions(seed: number, ticks: number, tuerLeBoss: boolean): Emission[] {
    const d = new WaveDirector(seed);
    const out: Emission[] = [];
    for (let tick = 0; tick < ticks; tick++) {
      const order = d.due(tick, [3000], [3000]);
      if (!order) {
        continue;
      }
      const boss = d.bossWaveId === order.waveId;
      out.push({ order, palier: d.palier, boss });
      if (boss && tuerLeBoss) {
        d.bossDefeated();
      }
    }
    return out;
  }

  const MINUTE = TICK_HZ * 60;

  it('demande un boss apres WAVES_PER_PALIER vagues ordinaires, et un seul', () => {
    const emis = emissions(1234, 2 * MINUTE, false);

    // ⚠️ **Le decor produit-il ce qu'il pretend mesurer ?** Toute la suite lit
    // « une vague d'UNE entite » comme « le boss ». Ca ne veut rien dire si les
    // vagues ordinaires pouvaient elles aussi n'avoir qu'une entite — la borne
    // basse de `waveCountBounds` vaut 10, mais c'est un reglage, pas une loi.
    const ordinaires = emis.filter((e) => !e.boss);
    expect(ordinaires.length).toBeGreaterThan(5);
    expect(ordinaires.every((e) => e.order.count > 1)).toBe(true);

    const premieres = emis.slice(0, WAVES_PER_PALIER);
    expect(premieres).toHaveLength(WAVES_PER_PALIER);
    expect(premieres.every((e) => !e.boss)).toBe(true);

    const cinquieme = emis[WAVES_PER_PALIER];
    expect(cinquieme?.boss).toBe(true);
    expect(cinquieme?.order.count).toBe(1);

    // Un seul boss sur deux minutes, puisque personne ne l'a tue. Le §1.1 de la
    // spec en fait une regle : la vie du boss ne voyage que parce qu'il est UN.
    expect(emis.filter((e) => e.boss)).toHaveLength(1);
  });

  /**
   * L'archetype du boss (etape 6a, tache 3).
   *
   * ⚠️ **Les deux moities.** « Le boss a l'archetype de boss » passe tout seul
   * avec un generateur qui ne saurait plus produire QUE des boss ; « les vagues
   * ordinaires ne l'ont pas » passe tout seul avec un generateur qui ne
   * produirait jamais de boss du tout. Il faut compter les deux populations, et
   * les compter non vides.
   */
  it('donne l archetype de boss au boss, et a lui seul', () => {
    const emis = emissions(1234, 10 * MINUTE, true);
    const boss = emis.filter((e) => e.boss);
    const ordinaires = emis.filter((e) => !e.boss);

    expect(boss.length).toBeGreaterThan(1);
    expect(ordinaires.length).toBeGreaterThan(WAVES_PER_PALIER);

    expect(boss.every((e) => e.order.archetype === BOSS_ARCHETYPE)).toBe(true);
    expect(ordinaires.every((e) => e.order.archetype !== BOSS_ARCHETYPE)).toBe(true);
  });

  it('ne cesse PAS de lacher des vagues pendant le combat de boss', () => {
    // ⚠️ **Ce test existe pour empecher une « correction » future.**
    // L'intuition « le boss, seul, en duel » est tentante et fausse pour ce
    // genre : un bullet heaven ou la horde disparait est un jeu qui s'arrete
    // (§2 et §9 de la spec, ecart assume). Sans cette assertion, geler les
    // vagues pendant le boss passerait tous les autres tests de ce fichier.
    const emis = emissions(1234, 2 * MINUTE, false);
    const indexBoss = emis.findIndex((e) => e.boss);

    expect(indexBoss).toBeGreaterThanOrEqual(0);
    const apres = emis.slice(indexBoss + 1);
    expect(apres.length).toBeGreaterThan(5);
    expect(apres.every((e) => !e.boss && e.order.count > 1)).toBe(true);
  });

  it('ne fait PAS avancer le palier avec le temps : sans mort de boss, il reste a zero', () => {
    // La premiere moitie. Un palier date par tick punirait l'equipe qui peine
    // et ennuierait celle qui domine (§2 de la spec).
    const emis = emissions(1234, 10 * MINUTE, false);

    expect(emis.length).toBeGreaterThan(50);
    expect(emis.every((e) => e.palier === 0)).toBe(true);
  });

  it('fait avancer le palier a la MORT du boss, une fois par boss tombe', () => {
    // La seconde moitie. Sans elle, un palier fige a zero passerait le test
    // precedent sans rien prouver du tout.
    const emis = emissions(1234, 10 * MINUTE, true);
    const bosses = emis.filter((e) => e.boss);

    expect(bosses.length).toBeGreaterThan(3);
    // Le boss du palier `k` tombe alors que le palier vaut encore `k` : les
    // paliers observes sur les boss sont donc 0, 1, 2, ... sans trou.
    expect(bosses.map((e) => e.palier)).toEqual(bosses.map((_, i) => i));

    // Et chaque palier comporte bien `WAVES_PER_PALIER` vagues ordinaires
    // avant son boss, puisque l'equipe le tue a l'apparition.
    const ordinairesParPalier = new Map<number, number>();
    for (const e of emis.filter((x) => !x.boss)) {
      ordinairesParPalier.set(e.palier, (ordinairesParPalier.get(e.palier) ?? 0) + 1);
    }
    for (const [palier, n] of ordinairesParPalier) {
      if (palier < bosses.length - 1) {
        expect(n).toBe(WAVES_PER_PALIER);
      }
    }
  });

  it('redemande le boss si la horde etait pleine quand son ordre est tombe', () => {
    // ⚠️ **Sans `bossMissing`, le verrou ne se relacherait jamais.** Le
    // directeur refuse un second boss tant que le premier n'est pas resolu ; un
    // boss tronque a l'apparition (`Horde.spawn` plafonne a `capacity`) n'est ni
    // vivant ni mort, et le palier resterait fige pour le reste de la run.
    const d = new WaveDirector(1234);
    let premierBoss: WaveOrder | null = null;
    let secondBoss: WaveOrder | null = null;
    for (let tick = 0; tick < 2 * MINUTE; tick++) {
      const order = d.due(tick, [3000], [3000]);
      if (!order || d.bossWaveId !== order.waveId) {
        continue;
      }
      if (premierBoss === null) {
        premierBoss = order;
        d.bossMissing();
      } else {
        secondBoss = order;
        break;
      }
    }

    expect(premierBoss).not.toBeNull();
    expect(secondBoss).not.toBeNull();
    expect(secondBoss?.waveId).not.toBe(premierBoss?.waveId);
    // ⚠️ Et le palier n'a PAS avance : un boss jamais apparu n'est pas un boss
    // vaincu. C'est ce qui distingue `bossMissing` de `bossDefeated` — sans
    // cette ligne, les deux methodes seraient interchangeables.
    expect(d.palier).toBe(0);
  });

  it('grossit les vagues avec le palier, et pas seulement en debut de run', () => {
    let debordements = 0;
    let ordinaires = 0;

    for (let seed = 1; seed <= 20; seed++) {
      for (const e of emissions(seed, 10 * MINUTE, true)) {
        if (e.boss) {
          continue;
        }
        ordinaires++;
        const { min, max } = waveCountBounds(e.order.waveId);
        const echelle = waveCountScale(e.palier);
        // La borne, mise a l'echelle du palier : c'est la seule que l'ordre
        // doive respecter.
        expect(e.order.count).toBeGreaterThanOrEqual(Math.round(min * echelle));
        expect(e.order.count).toBeLessThanOrEqual(Math.round(max * echelle));

        // ⚠️ **La moitie qui compte.** Les deux assertions ci-dessus passent
        // telles quelles avec une echelle constamment egale a 1 : elles
        // reduisent alors aux bornes brutes. Il faut donc voir des ordres qui
        // DEPASSENT la borne brute de leur numero de vague, ce qu'aucune vague
        // du palier 0 ne peut faire.
        if (e.palier > 0 && e.order.count > max) {
          debordements++;
        }
      }
    }

    expect(ordinaires).toBeGreaterThan(500);
    expect(debordements).toBeGreaterThan(0);
  });
});
