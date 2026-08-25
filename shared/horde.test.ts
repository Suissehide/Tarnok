import { describe, expect, it } from 'vitest';

import {
  CONTACT_RADIUS,
  FLOWFIELD_HZ,
  MAX_ENTITIES,
  STEERING_RECOMPUTE_TICKS,
  STEERING_REPULSION_STRENGTH,
  TICK_HZ,
} from './constants';
import { FlowField } from './flowfield';
import { entityIdOf, Horde } from './horde';
import { PlayerHistory } from './player-history';
import { FORMATION, type WaveOrder } from './waves';

const DT = 1 / 30;

function order(overrides: Partial<WaveOrder> = {}): WaveOrder {
  return {
    waveId: 1,
    spawnTick: 0,
    seed: 0x1234,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 1000,
    anchorY: 1000,
    count: 50,
    ...overrides,
  };
}

function fieldsTowards(x: number, y: number): FlowField[] {
  return Array.from({ length: 4 }, () => {
    const f = new FlowField(6000, 64);
    f.update(x, y);
    return f;
  });
}

describe('entityIdOf', () => {
  it('ne produit jamais deux fois le meme identifiant', () => {
    const ids = new Set<number>();
    for (let wave = 0; wave < 50; wave++) {
      for (let i = 0; i < 100; i++) {
        ids.add(entityIdOf(wave, i));
      }
    }

    expect(ids.size).toBe(50 * 100);
  });

  it('ne recycle pas : la vague 2 ne reprend pas les identifiants de la vague 1', () => {
    expect(entityIdOf(2, 0)).toBeGreaterThan(entityIdOf(1, 4095));
  });
});

describe('Horde.spawn', () => {
  it('ajoute exactement le nombre demande', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 250 }));

    expect(horde.count).toBe(250);
  });

  it('cumule les vagues', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 100 }));
    horde.spawn(order({ waveId: 2, count: 150 }));

    expect(horde.count).toBe(250);
  });

  it('donne a chaque entite son identite et son archetype', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 3, archetype: 2, count: 10 }));

    expect(horde.entityIdAt(0)).toBe(entityIdOf(3, 0));
    expect(horde.archetype[0]).toBe(2);
  });

  it('disperse les phases d animation : mille crânes ne marchent pas au pas', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 300 }));

    const phases = new Set([...horde.animPhase.slice(0, 300)]);
    expect(phases.size).toBeGreaterThan(3);
  });

  it('refuse de depasser sa capacite au lieu de deborder', () => {
    const horde = new Horde(100);
    horde.spawn(order({ count: 80 }));
    horde.spawn(order({ waveId: 2, count: 80 }));

    expect(horde.count).toBe(100);
  });

  it('prend MAX_ENTITIES comme capacite par defaut, pour que deux simulations tronquent pareil', () => {
    expect(new Horde().capacity).toBe(MAX_ENTITIES);
  });
});

describe('Horde.step', () => {
  it('fait converger la horde vers la cible du champ', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 100, anchorX: 1000, anchorY: 1000 }));
    const fields = fieldsTowards(4000, 4000);
    horde.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);

    const avant = meanDistanceTo(horde, 4000, 4000);
    for (let i = 0; i < 300; i++) {
      horde.step(DT, fields, i);
    }

    expect(meanDistanceTo(horde, 4000, 4000)).toBeLessThan(avant - 500);
  });

  it('est deterministe : deux hordes, memes ordres, memes positions', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);
    for (const h of [a, b]) {
      h.spawn(order({ count: 200 }));
      h.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);
      for (let i = 0; i < 200; i++) {
        h.step(DT, fields, i);
      }
    }

    expect([...a.x.slice(0, 200)]).toEqual([...b.x.slice(0, 200)]);
  });

  it('ne sort pas de la carte', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 100 }));
    const fields = fieldsTowards(0, 0);
    horde.retarget([0, 0, 0, 0], [0, 0, 0, 0]);
    for (let i = 0; i < 2000; i++) {
      horde.step(DT, fields, i);
    }

    for (let i = 0; i < horde.count; i++) {
      expect(horde.x[i]).toBeGreaterThanOrEqual(0);
      expect(horde.y[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Horde.spawnCatchingUp', () => {
  it('avec missedTicks a zero, donne exactement le meme resultat que spawn', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);

    a.spawn(order({ count: 100 }));
    b.spawnCatchingUp(order({ count: 100 }), 0, DT, fields);

    expect(a.count).toBe(b.count);
    expect([...a.x.slice(0, 100)]).toEqual([...b.x.slice(0, 100)]);
    expect([...a.y.slice(0, 100)]).toEqual([...b.y.slice(0, 100)]);
  });

  it('avec missedTicks positif, les nouvelles entites sont plus avancees', () => {
    const fields = fieldsTowards(4000, 4000);
    const rattrape = new Horde(1000);
    const normal = new Horde(1000);

    rattrape.spawnCatchingUp(order({ count: 100, anchorX: 1000, anchorY: 1000 }), 2, DT, fields);
    normal.spawn(order({ count: 100, anchorX: 1000, anchorY: 1000 }));

    const avantRattrape = meanDistanceTo(rattrape, 4000, 4000);
    const avantNormal = meanDistanceTo(normal, 4000, 4000);

    expect(avantRattrape).toBeLessThan(avantNormal);
  });

  it("n'affecte pas les entites deja presentes", () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 50, anchorX: 1000, anchorY: 1000 }));
    const fields = fieldsTowards(1000, 1000);
    horde.retarget([1000, 1000, 1000, 1000], [1000, 1000, 1000, 1000]);

    const avantX = [...horde.x.slice(0, 50)];
    const avantY = [...horde.y.slice(0, 50)];

    horde.spawnCatchingUp(
      order({ waveId: 2, count: 50, anchorX: 5000, anchorY: 5000 }),
      5,
      DT,
      fields,
    );

    expect([...horde.x.slice(0, 50)]).toEqual(avantX);
    expect([...horde.y.slice(0, 50)]).toEqual(avantY);
  });

  it('produit le meme nombre d entites que spawn, rattrapage ou non', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);

    a.spawn(order({ count: 100 }));
    b.spawnCatchingUp(order({ count: 100 }), 3, DT, fields);

    expect(b.count).toBe(a.count);
  });
});

describe('Horde.spawnCatchingUp — garde-fou de fraicheur des champs', () => {
  it("dans l'ordre correct (rattrapage avant le rafraichissement du tick), ne leve pas", () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);

    // `step` a deja tourne au moins une fois : la horde est « avancee ».
    horde.step(DT, fields, 0);

    // Aucun `update` sur les champs depuis ce `step` : le rattrapage voit les
    // memes revisions qu'au dernier pas, comme dans l'ordre correct d'un tick.
    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).not.toThrow();
  });

  it('precede par un rafraichissement du champ, leve — et le message parle de l ordre', () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);

    horde.step(DT, fields, 0);
    // Rafraichissement periodique du tick, appele — a tort — avant le
    // rattrapage plutot qu'apres.
    fields[0]?.update(1000, 1000);

    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).toThrow(/avant tout appel a FlowField\.update/);
  });

  it('sur une horde jamais avancee (tout premier ordre), ne leve pas', () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);
    // Un rafraichissement a deja eu lieu, mais `step` n'a encore jamais
    // tourne : rien n'a ete releve, donc rien a comparer.
    fields[0]?.update(1000, 1000);

    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).not.toThrow();
  });

  it("n'affecte pas le comportement nominal de step", () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);
    horde.spawn(order({ count: 50 }));
    horde.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);

    const avant = meanDistanceTo(horde, 4000, 4000);
    for (let i = 0; i < 100; i++) {
      horde.step(DT, fields, i);
    }

    expect(meanDistanceTo(horde, 4000, 4000)).toBeLessThan(avant);
  });
});

describe('Horde.retarget', () => {
  it('envoie chaque entite vers le joueur le plus proche', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 100;
    horde.y[0] = 100;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    horde.retarget([0, 5900], [0, 5900]);

    expect(horde.targetField[0]).toBe(0);
    expect(horde.targetField[1]).toBe(1);
  });

  /**
   * Tache 17.2 : l'arret au contact se decide ICI, dans `retarget` — au meme
   * endroit et a la meme cadence que le reciblage, a partir des positions
   * DEJA retardees que l'appelant lui passe (§5 de la spec, voir
   * `PlayerHistory.delayed`). `Horde` ne sait rien du reseau ; il ne fait que
   * comparer sa propre position, deja identique des deux cotes par
   * construction, a celle qu'on lui donne.
   */
  it('marque une entite arretee quand son joueur le plus proche est a portee de contact', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 100;
    horde.y[0] = 100;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    // Le joueur associe a l'entite 0 est colle a elle ; celui associe a
    // l'entite 1 en reste tres eloigne.
    horde.retarget([100, 5900], [100, 5900]);

    expect(horde.stopped[0]).toBe(1);
    expect(horde.stopped[1]).toBe(0);
  });

  /**
   * Fixe la portee d'arret sur `CONTACT_RADIUS` precisement — pas sur un
   * nombre invente a cote (`SEPARATION_RADIUS`, `PROJECTILE_HIT_RADIUS`, ou
   * une constante propre qui se degraderait sans jamais suivre l'arbitrage
   * serveur). Une entite juste EN DECA doit s'arreter, une entite juste
   * AU-DELA doit continuer d'avancer.
   */
  it("utilise CONTACT_RADIUS comme portee d'arret, pas un nombre invente a cote", () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 1000;
    horde.y[0] = 1000;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    horde.retarget([1000 + CONTACT_RADIUS - 1, 5000 + CONTACT_RADIUS + 1], [1000, 5000]);

    expect(horde.stopped[0]).toBe(1);
    expect(horde.stopped[1]).toBe(0);
  });
});

/**
 * Tache 17.2 : une entite arretee cesse d'avancer, meme si le champ continue
 * de la tirer fort ailleurs — sans quoi elle traverserait quand meme le
 * joueur, exactement le defaut remonte en jeu.
 */
describe('Horde.step laisse une entite arretee sur place', () => {
  it("une entite marquee arretee (retarget) n'avance plus, meme apres plusieurs pas", () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
    horde.x[0] = 1000;
    horde.y[0] = 1000;
    // Champ qui tire fortement ailleurs : si le garde-fou d'arret manquait,
    // l'entite s'en rapprocherait visiblement en 100 pas.
    const fields = fieldsTowards(4000, 4000);

    // Le joueur cible est colle a l'entite : elle doit s'arreter des ce
    // reciblage.
    horde.retarget([1000, 1000, 1000, 1000], [1000, 1000, 1000, 1000]);
    expect(horde.stopped[0]).toBe(1); // sanity : le garde teste bien un cas arrete

    const beforeX = horde.x[0];
    const beforeY = horde.y[0];
    for (let i = 0; i < 100; i++) {
      horde.step(DT, fields, i);
    }

    expect(horde.x[0]).toBe(beforeX);
    expect(horde.y[0]).toBe(beforeY);
  });
});

/**
 * Tache 17.2, garde-fou explicitement demande par le brief : « un monstre
 * arrive a portee cesse d'avancer, et les deux cotes s'arretent au meme
 * tick ». Rejoue la boucle production (`PlayerHistory.record/delayed`,
 * `retarget` a la cadence du flowfield, `step` a chaque tick — exactement le
 * montage de `Room.step` et `GameClient#advanceHorde`) deux fois de suite,
 * sur deux graphes d'objets independants, et verifie que :
 *  - le monstre a REELLEMENT avance avant de s'arreter (sinon le test ne
 *    prouverait rien : une horde immobile depuis le premier tick "s'arrete"
 *    trivialement) ;
 *  - il s'arrete au MEME tick des deux cotes ;
 *  - il reste immobile apres.
 */
describe("Horde s'arrete au contact de facon deterministe", () => {
  it('un monstre qui approche cesse d avancer une fois a portee, au meme tick des deux simulations', () => {
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const MAP = 6000;
    const CELL = 64;
    // Le joueur marche vers (TARGET_X, FIXED_Y) pendant RAMP_TICKS puis s'y
    // IMMOBILISE : sans palier final, un joueur qui continue tout droit finit
    // par depasser un monstre deja a l'arret et rouvre la distance — ce n'est
    // pas un defaut (l'arret n'a pas a etre un cliquet : un monstre distance
    // doit pouvoir se remettre a poursuivre), mais ca rendrait ce test
    // instable pour une raison etrangere a ce qu'il verifie. Voir le rapport
    // de la tache 17 pour la mesure qui a fait choisir ce palier.
    const TOTAL_TICKS = 500;
    const RAMP_TICKS = 200;
    const START_X = 0;
    const TARGET_X = 2500;
    const FIXED_Y = 3000;

    interface RunResult {
      /** Tick de la DERNIERE transition 0 -> 1 : celle qui tient jusqu'a la fin. */
      stopTick: number;
      positions: { x: number; y: number }[];
    }

    function playerXAt(tick: number): number {
      const t = Math.min(1, tick / RAMP_TICKS);
      return START_X + (TARGET_X - START_X) * t;
    }

    function run(): RunResult {
      const horde = new Horde(4);
      horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
      // Position fixe et connue : la formation SCATTER disperse sur 900 px,
      // ce que ce test n'a pas besoin de negocier.
      horde.x[0] = 3000;
      horde.y[0] = FIXED_Y;

      const fields = [new FlowField(MAP, CELL)];
      const history = new PlayerHistory();
      const positions: { x: number; y: number }[] = [];
      let stopTick = -1;
      let wasStopped = false;

      for (let tick = 0; tick < TOTAL_TICKS; tick++) {
        history.record(tick, [playerXAt(tick)], [FIXED_Y]);
        if (tick % stepsPerField === 0) {
          const seen = history.delayed(tick);
          if (seen) {
            fields[0]?.update(seen.x[0] ?? 0, seen.y[0] ?? 0);
            horde.retarget(seen.x, seen.y);
          }
        }
        horde.step(DT, fields, tick);
        positions.push({ x: horde.x[0] ?? 0, y: horde.y[0] ?? 0 });
        const isStopped = horde.stopped[0] === 1;
        if (isStopped && !wasStopped) {
          stopTick = tick;
        }
        wasStopped = isStopped;
      }

      return { stopTick, positions };
    }

    const a = run();
    const b = run();

    expect(a.stopTick).toBeGreaterThan(0);
    expect(a.stopTick).toBe(b.stopTick);

    // Elle a REELLEMENT avance avant de s'arreter : sans cette assertion, une
    // horde immobile depuis le premier tick « s'arreterait » trivialement et
    // le test ne prouverait rien.
    const early = a.positions[5] ?? { x: 0, y: 0 };
    const justBefore = a.positions[a.stopTick - 1] ?? early;
    expect(Math.hypot(justBefore.x - early.x, justBefore.y - early.y)).toBeGreaterThan(50);

    // Et elle reste immobile jusqu'au bout une fois arretee pour de bon.
    const atStop = a.positions[a.stopTick] ?? { x: 0, y: 0 };
    const atEnd = a.positions[a.positions.length - 1] ?? atStop;
    expect(atEnd.x).toBe(atStop.x);
    expect(atEnd.y).toBe(atStop.y);
  });
});

describe('Horde.kill', () => {
  it('retire les entites demandees', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 10 }));
    const cible = horde.entityIdAt(3);

    expect(horde.kill([cible])).toBe(1);
    expect(horde.count).toBe(9);
    expect(horde.slotOf(cible)).toBe(-1);
  });

  it('ignore une identite inconnue sans planter', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 5 }));

    expect(horde.kill([999_999])).toBe(0);
    expect(horde.count).toBe(5);
  });

  // ⚠️ Note sur le test ci-dessous : il compare deux executions du MEME code,
  // donc il prouve qu'un tri deterministe existe, pas qu'il est decroissant.
  // C'est « preserve toutes les entites survivantes » qui porte cette
  // exigence — verifie : passer le tri en croissant le fait echouer, et lui
  // seul. Les deux se tiennent ; ne pas supprimer l'un en gardant l'autre.
  it('donne le meme resultat quel que soit l ordre de la liste', () => {
    // Le protocole trie les identites, mais rien n'empeche un appelant de
    // passer une liste desordonnee : le resultat doit etre identique, sinon
    // deux clients compacteraient differemment.
    const a = new Horde(1000);
    const b = new Horde(1000);
    a.spawn(order({ count: 20 }));
    b.spawn(order({ count: 20 }));
    const ids = [a.entityIdAt(2), a.entityIdAt(7), a.entityIdAt(15)];

    a.kill(ids);
    b.kill([...ids].reverse());

    const idsDe = (h: Horde): number[] =>
      Array.from({ length: h.count }, (_, i) => h.entityIdAt(i));
    expect(idsDe(a)).toEqual(idsDe(b));
  });

  it('ne retire qu une fois une identite listee deux fois', () => {
    // Rien dans le protocole ne garantit l'unicite : deux armes qui achevent la
    // meme entite au meme tick peuvent l'inscrire deux fois dans le lot. Sans
    // garde, la seconde passe supprime l'entite vivante deplacee dans le trou.
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const cible = horde.entityIdAt(3);
    const survivants = new Set(
      Array.from({ length: 10 }, (_, i) => horde.entityIdAt(i)).filter((id) => id !== cible),
    );

    expect(horde.kill([cible, cible])).toBe(1);
    expect(horde.count).toBe(9);

    const apres = new Set(Array.from({ length: horde.count }, (_, i) => horde.entityIdAt(i)));
    expect(apres).toEqual(survivants);
  });

  it('preserve toutes les entites survivantes', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const avant = new Set(Array.from({ length: 10 }, (_, i) => horde.entityIdAt(i)));
    const morts = [horde.entityIdAt(0), horde.entityIdAt(9)];

    horde.kill(morts);

    const apres = new Set(Array.from({ length: horde.count }, (_, i) => horde.entityIdAt(i)));
    for (const id of avant) {
      expect(apres.has(id)).toBe(!morts.includes(id));
    }
  });

  it('emmene toutes les proprietes de l entite deplacee, pas seulement sa position', () => {
    // La compaction deplace la derniere entite dans le trou. Si un seul tableau
    // etait oublie, cette entite garderait l'archetype ou la cible du mort —
    // et l'etape 3 le paierait en sprites melanges, ou pire en monstres qui
    // poursuivent le champ de flux d'un autre joueur.
    //
    // ⚠️ Les NEUF tableaux sont verifies, un par un (`stopped` depuis la
    // tache 17.2, `vx`/`vy` depuis la tache 19). Une premiere version de ce
    // test n'en verifiait que deux — `archetype` et `animPhase` — alors que
    // son nom promet « pas seulement sa position ». Verifie : supprimer la
    // copie de `x`, de `y` ou de `targetField` laissait les 26 tests verts.
    //
    // Si un tableau est ajoute a `Horde`, il doit apparaitre ICI et dans
    // `#removeAt`. Les deux listes se tiennent.
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, archetype: 0, count: 5 }));
    horde.spawn(order({ waveId: 2, archetype: 3, count: 5 }));
    const last = horde.count - 1;
    // Valeurs distinctives : deux entites qui partagent deja une valeur ne
    // prouveraient rien d'une copie manquante.
    horde.x[last] = 1234.5;
    horde.y[last] = 6789.5;
    horde.vx[last] = 12.5;
    horde.vy[last] = -34.5;
    horde.targetField[last] = 3;
    horde.stopped[last] = 1;
    const attendu = {
      entityId: horde.entityIdAt(last),
      x: horde.x[last],
      y: horde.y[last],
      vx: horde.vx[last],
      vy: horde.vy[last],
      archetype: horde.archetype[last],
      waveId: horde.waveId[last],
      indexInWave: horde.indexInWave[last],
      animPhase: horde.animPhase[last],
      targetField: horde.targetField[last],
      stopped: horde.stopped[last],
    };

    horde.kill([horde.entityIdAt(0)]);

    const slot = horde.slotOf(attendu.entityId);
    expect(slot).toBe(0);
    expect(horde.x[slot]).toBe(attendu.x);
    expect(horde.y[slot]).toBe(attendu.y);
    expect(horde.vx[slot]).toBe(attendu.vx);
    expect(horde.vy[slot]).toBe(attendu.vy);
    expect(horde.archetype[slot]).toBe(attendu.archetype);
    expect(horde.waveId[slot]).toBe(attendu.waveId);
    expect(horde.indexInWave[slot]).toBe(attendu.indexInWave);
    expect(horde.animPhase[slot]).toBe(attendu.animPhase);
    expect(horde.targetField[slot]).toBe(attendu.targetField);
    expect(horde.stopped[slot]).toBe(attendu.stopped);
  });

  it('ignore une identite inconnue melangee a une connue', () => {
    // ⚠️ C'est le seul cas qui rende le filtre `slot >= 0` porteur. Avec une
    // identite inconnue SEULE, le garde de doublon la confond avec `previous`
    // initialise a -1 et masque le defaut par hasard : la mutation passe. Une
    // inconnue melangee a une connue ne beneficie plus de cette coincidence.
    //
    // Sans le filtre, `#removeAt(-1)` decremente `#count` en ecrivant dans le
    // vide — l'ecriture a un indice negatif sur un tableau type est un no-op
    // silencieux — et une entite vivante disparait du compte.
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const cible = horde.entityIdAt(4);

    expect(horde.kill([cible, 999_999])).toBe(1);
    expect(horde.count).toBe(9);
    expect(horde.slotOf(cible)).toBe(-1);
  });
});

describe('tache 18 : pas de naissance en plein mur, sortie d un mur garantie', () => {
  it('Horde.spawn evite les cellules murees quand on lui passe un champ', () => {
    const field = new FlowField(6000, 64);
    // Un pate de mur autour de l'ancre, assez large pour que plusieurs des
    // positions SCATTER calculees SANS le champ y tombent directement (verifie
    // par la premiere boucle ci-dessous).
    const anchorCol = field.indexAt(1000, 1000) % field.cols;
    const anchorRow = Math.floor(field.indexAt(1000, 1000) / field.cols);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        field.block(anchorCol + dx, anchorRow + dy);
      }
    }
    field.update(1000, 1000); // cible hors du pate, sans effet sur `blocked`

    const withoutObstacles = new Horde(500);
    withoutObstacles.spawn(order({ count: 400, anchorX: 1000, anchorY: 1000 }));
    let rawInWall = 0;
    for (let i = 0; i < withoutObstacles.count; i++) {
      const cell = field.indexAt(withoutObstacles.x[i] ?? 0, withoutObstacles.y[i] ?? 0);
      if (field.blocked[cell] === 1) {
        rawInWall++;
      }
    }
    // Le test ne prouverait rien si le pate de mur, par accident, ne genait
    // aucune position brute.
    expect(rawInWall).toBeGreaterThan(0);

    const withObstacles = new Horde(500);
    withObstacles.spawn(order({ count: 400, anchorX: 1000, anchorY: 1000 }), field);
    for (let i = 0; i < withObstacles.count; i++) {
      const cell = field.indexAt(withObstacles.x[i] ?? 0, withObstacles.y[i] ?? 0);
      expect(field.blocked[cell]).toBe(0);
    }
  });

  it('une entite coincee dans un mur en ressort au bout de quelques pas de Horde.step', () => {
    const field = new FlowField(6000, 64);
    // Un mur epais de 3 cellules entre l'entite et la cible : sans la sortie
    // de secours (tache 18), la cellule centrale ne porterait aucune
    // direction et l'entite y resterait figee pour toujours.
    const startCol = field.indexAt(1000, 1000) % field.cols;
    const startRow = Math.floor(field.indexAt(1000, 1000) / field.cols);
    for (let k = 0; k < 3; k++) {
      field.block(startCol + k, startRow);
    }
    field.update(3000, 1000);
    const fields = [field, field, field, field];

    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: 5000, anchorY: 5000 })); // loin du mur, position ecrasee juste apres
    // Centre de la cellule bloquee du milieu (colonne startCol+1, ligne
    // startRow). ⚠️ Piege verifie a la main lors de l'ecriture de ce test :
    // une premiere version utilisait la MEME formule pour x et y (1000 + 32),
    // ce qui place l'entite ligne startRow+1 — jamais bloquee — et le test
    // passait meme avec la sortie de secours desactivee, sans rien prouver.
    // D'ou l'assertion de precondition juste en dessous.
    horde.x[0] = (startCol + 1 + 0.5) * 64;
    horde.y[0] = (startRow + 0.5) * 64;
    expect(field.blocked[field.indexAt(horde.x[0] ?? 0, horde.y[0] ?? 0)]).toBe(1);

    let escaped = false;
    for (let t = 0; t < 60; t++) {
      horde.step(DT, fields, t);
      const cell = field.indexAt(horde.x[0] ?? 0, horde.y[0] ?? 0);
      if (field.blocked[cell] === 0) {
        escaped = true;
        break;
      }
    }

    expect(escaped).toBe(true);
  });
});

describe('tache 19 : recalcul de trajectoire par intervalle', () => {
  it('step avec dt <= 0 est un NO-OP STRICT, y compris pour vx/vy (rejoue le gel cote client)', () => {
    // Mutation visee : `if (dt > 0) { ... }` retire de `Horde.step`. Rejoue
    // exactement l'asymetrie gel decrite dans sa doc : le serveur (`Room.step`)
    // ne rappelle JAMAIS `horde.step` pendant le gel strict (retour anticipe
    // avant meme de calculer `scaledDt`), alors que `GameClient#advanceHorde`
    // l'appelle quand meme avec `dt * 0`. Si `dt <= 0` recalculait quand meme
    // `vx`/`vy`, le « client » ci-dessous partirait de la reprise avec une
    // vitesse que le « serveur » n'a jamais posee.
    const serveur = new Horde(10);
    const client = new Horde(10);
    for (const h of [serveur, client]) {
      h.spawn(order({ count: 5, formation: FORMATION.CLUSTER, anchorX: 3000, anchorY: 3000 }));
    }
    const fields = fieldsTowards(6000, 3000);
    for (const h of [serveur, client]) {
      h.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
    }

    const AVANT_GEL = 5;
    const GEL = 20; // largement > K, pour laisser le temps a un recalcul errone de se produire.
    for (let tick = 0; tick < AVANT_GEL; tick++) {
      for (const h of [serveur, client]) {
        h.step(DT, fields, tick);
      }
    }

    // Pendant le « gel » : le serveur SAUTE l'appel (comme `Room.step`), le
    // client l'appelle quand meme avec `dt = 0` (comme `GameClient#advanceHorde`).
    for (let tick = AVANT_GEL; tick < AVANT_GEL + GEL; tick++) {
      client.step(0, fields, tick);
    }

    // La reprise : les deux doivent repartir du MEME etat, vitesse comprise.
    for (let tick = AVANT_GEL + GEL; tick < AVANT_GEL + GEL + 5; tick++) {
      for (const h of [serveur, client]) {
        h.step(DT, fields, tick);
      }
    }

    for (let i = 0; i < serveur.count; i++) {
      expect(client.vx[i]).toBe(serveur.vx[i]);
      expect(client.vy[i]).toBe(serveur.vy[i]);
      expect(client.x[i]).toBe(serveur.x[i]);
      expect(client.y[i]).toBe(serveur.y[i]);
    }
  });

  it('la vitesse est TENUE entre deux recalculs : elle ne bouge pas quand le champ change entre-temps', () => {
    // Mutation visee : un recalcul qui aurait lieu a CHAQUE tick plutot qu'un
    // tick sur K. Une seule entite, sans voisin (repulsion nulle par
    // construction), pour que la seule source de changement de vx/vy soit le
    // recalcul lui-meme.
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
    horde.x[0] = 3000;
    horde.y[0] = 3000;
    const fields = fieldsTowards(6000, 3000);
    horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);

    const K = STEERING_RECOMPUTE_TICKS;
    const phase = horde.entityIdAt(0) % K;

    // Avance jusqu'au premier recalcul (tick === phase) pour partir d'une
    // vitesse fraichement posee, tournee vers (6000, 3000).
    for (let tick = 0; tick <= phase; tick++) {
      horde.step(DT, fields, tick);
    }
    const vxApresRecalcul = horde.vx[0] ?? 0;
    const vyApresRecalcul = horde.vy[0] ?? 0;
    // Sanity : le recalcul a bien pose une vitesse non nulle, vers l'est.
    expect(vxApresRecalcul).toBeGreaterThan(0);
    expect(vyApresRecalcul).toBeCloseTo(0, 5);

    // Le champ change de direction (vers le nord) APRES ce recalcul : si
    // l'entite recalculait a chaque tick, sa vitesse suivrait immediatement.
    // Si elle la TIENT, comme le veut la tache 19, `vx`/`vy` doivent rester
    // EXACTEMENT ce qu'ils etaient, jusqu'a son prochain tick de phase.
    for (const f of fields) {
      f.update(3000, 0);
    }
    horde.retarget([3000, 3000, 3000, 3000], [0, 0, 0, 0]);

    for (let k = 1; k < K; k++) {
      const tick = phase + k;
      horde.step(DT, fields, tick);
      expect(horde.vx[0]).toBe(vxApresRecalcul);
      expect(horde.vy[0]).toBe(vyApresRecalcul);
    }

    // Et elle avance bien en LIGNE DROITE pendant ce temps : le deplacement
    // cumule sur ces K-1 pas est exactement `vitesse * (K-1) * dt`, a la
    // clampe de bord pres (loin ici de tout bord).
    const attendu = vxApresRecalcul * DT * (K - 1);
    // Precision a 1 decimale : Float32Array accumule une erreur d'arrondi sur
    // K additions successives, sans rapport avec ce que ce test verifie.
    expect(horde.x[0] ?? 0).toBeCloseTo(3000 + vxApresRecalcul * DT + attendu, 1);
  });

  it("la phase de recalcul vient de l'identite : deux entites d ids differents ne recalculent pas au meme tick, et l'identite suit une entite compactee dans un nouveau creneau", () => {
    // Mutation visee : une phase derivee de l'INDICE DE CRENEAU plutot que de
    // l'identite (`entityIdAt`). Les deux coincident a l'apparition — ce test
    // les fait diverger expres par une compaction, pour que la mutation
    // n'ait nulle part ou se cacher.
    const K = STEERING_RECOMPUTE_TICKS;
    const horde = new Horde(20);
    horde.spawn(order({ waveId: 1, count: K + 1, formation: FORMATION.SCATTER }));
    // Toutes au meme endroit, loin de tout bord : seule la phase peut
    // expliquer quand chacune obtient sa premiere vitesse non nulle.
    for (let i = 0; i < horde.count; i++) {
      horde.x[i] = 3000;
      horde.y[i] = 3000;
    }
    const fields = fieldsTowards(6000, 3000);
    horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);

    // L'identite qui va se retrouver au creneau 0 apres compaction : la
    // DERNIERE (index K), jamais l'identite d'origine du creneau 0.
    const survivorId = horde.entityIdAt(K);
    const phaseParIdentite = survivorId % K;
    // Le piege que ce test doit attraper : une implementation qui derive la
    // phase du CRENEAU (0 apres compaction) plutot que de l'identite donnerait
    // 0 % K = 0 — presque toujours different de `phaseParIdentite` ci-dessus.
    const phaseSiParCreneau = 0 % K;
    expect(phaseParIdentite).not.toBe(phaseSiParCreneau);

    // Tue le creneau 0 : la compaction (`Horde.kill`) deplace la derniere
    // entite (celle d'identite `survivorId`) dans le trou.
    horde.kill([horde.entityIdAt(0)]);
    expect(horde.entityIdAt(0)).toBe(survivorId); // sanity : bien compactee au creneau 0

    let firstNonZeroTick = -1;
    for (let tick = 0; tick < 3 * K; tick++) {
      horde.step(DT, fields, tick);
      if (firstNonZeroTick < 0 && ((horde.vx[0] ?? 0) !== 0 || (horde.vy[0] ?? 0) !== 0)) {
        firstNonZeroTick = tick;
      }
    }

    expect(firstNonZeroTick).toBe(phaseParIdentite);
  });

  it('aucun deplacement ne depasse le plafond de repulsion, meme entassee', () => {
    // Isole la repulsion de la direction du champ : les entites sont posees
    // PILE sur la cible de leur champ, ou `FlowField` rend (0, 0) par
    // construction (voir sa doc) — tout `vx`/`vy` mesure ici est donc
    // ENTIEREMENT la repulsion, sans avoir besoin de reproduire la formule de
    // `#recomputeSteering` dans ce test pour la soustraire.
    const TARGET_X = 3000;
    const TARGET_Y = 3000;
    const N = 11; // une « victime » plus dix voisins presque colles.
    const horde = new Horde(N);
    horde.spawn(order({ count: N, formation: FORMATION.SCATTER }));
    horde.x[0] = TARGET_X;
    horde.y[0] = TARGET_Y;
    for (let i = 1; i < N; i++) {
      // Meme piege documente dans shared/separation.test.ts (tache 18) :
      // EXACTEMENT la meme position donnerait d2 = 0, une paire ignoree par
      // construction plutot que plafonnee. 0,001 px suffit a rester a
      // l'interieur de SEPARATION_RADIUS tout en evitant ce piege.
      horde.x[i] = TARGET_X + 0.001;
      horde.y[i] = TARGET_Y;
    }
    const fields = fieldsTowards(TARGET_X, TARGET_Y);
    horde.retarget(
      [TARGET_X, TARGET_X, TARGET_X, TARGET_X],
      [TARGET_Y, TARGET_Y, TARGET_Y, TARGET_Y],
    );

    let maxSpeed = 0;
    const CAP = STEERING_REPULSION_STRENGTH * 1.0001; // marge flottante minime.
    for (let tick = 0; tick < STEERING_RECOMPUTE_TICKS + 2; tick++) {
      horde.step(DT, fields, tick);
      for (let i = 0; i < horde.count; i++) {
        const speed = Math.hypot(horde.vx[i] ?? 0, horde.vy[i] ?? 0);
        expect(speed).toBeLessThanOrEqual(CAP);
        if (speed > maxSpeed) {
          maxSpeed = speed;
        }
      }
    }

    // Le test ne prouverait rien sur le plafond si l'entassement n'avait
    // jamais approche la borne (voir la meme remarque dans
    // shared/separation.test.ts, tache 18).
    expect(maxSpeed).toBeGreaterThan(CAP * 0.5);
  });

  it('une entite qui recalcule voit TOUS ses voisins, meme ceux d un indice de creneau INFERIEUR', () => {
    // Mutation visee : la reapparition du parcours symetrique `j > i` de
    // l'ancien `SeparationGrid` (voir sa doc, tache 18) — une optimisation
    // valide seulement quand tout le monde recalcule au meme tick, et que la
    // tache 19 interdit precisement pour cette raison (voir le rapport).
    // Avec `j > i`, l'entite de creneau 0 verrait l'entite de creneau 1 (1 >
    // 0), mais l'entite de creneau 1 ne verrait JAMAIS celle de creneau 0
    // (0 <= 1) : sa vitesse ne porterait alors QUE la direction du champ,
    // jamais la repulsion de sa voisine.
    //
    // Deux entites presque colles, toutes deux posees PILE sur la cible de
    // leur champ (flux nul, meme piege evite que le test precedent) : tout
    // `vx`/`vy` mesure est donc ENTIEREMENT la repulsion.
    const TARGET_X = 3000;
    const TARGET_Y = 3000;
    const horde = new Horde(2);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = TARGET_X;
    horde.y[0] = TARGET_Y;
    horde.x[1] = TARGET_X + 0.001;
    horde.y[1] = TARGET_Y;
    const fields = fieldsTowards(TARGET_X, TARGET_Y);
    horde.retarget(
      [TARGET_X, TARGET_X, TARGET_X, TARGET_X],
      [TARGET_Y, TARGET_Y, TARGET_Y, TARGET_Y],
    );

    // Assez de pas pour que CHAQUE creneau ait recalcule au moins une fois,
    // quelle que soit sa phase.
    for (let tick = 0; tick < 2 * STEERING_RECOMPUTE_TICKS; tick++) {
      horde.step(DT, fields, tick);
    }

    // Le creneau DE PLUS HAUT INDICE (1) doit, lui aussi, porter une vitesse
    // de repulsion non nulle — c'est precisement ce que `j > i` lui
    // interdirait.
    expect(Math.hypot(horde.vx[1] ?? 0, horde.vy[1] ?? 0)).toBeGreaterThan(0);
    // Sanity : le creneau 0 la voit aussi (jamais concerne par le piege).
    expect(Math.hypot(horde.vx[0] ?? 0, horde.vy[0] ?? 0)).toBeGreaterThan(0);
  });

  it('deux clients simules independamment s accordent tick pour tick, y compris a travers un rejeu (rollback)', () => {
    // Le point precis que ce test cherche a attraper : une vitesse tenue
    // (`vx`/`vy`) qui serait SAUVEGARDEE mais pas RESTAUREE (ou l'inverse) —
    // exactement le defaut qu'une regression sur `HordeState`/`saveState`/
    // `restoreState` introduirait sans faire rougir aucun autre test de ce
    // fichier. Deux hordes independantes, une mort livree en RETARD a la
    // seconde (latence reseau simulee), rejouee via restauration + rejeu —
    // le meme montage que le scenario 9 de `horde.replication.test.ts`, en
    // miniature et cible sur `vx`/`vy` specifiquement.
    const fields = fieldsTowards(6000, 3000);
    const stepsPerField = 3;

    function makeParticipant(): { horde: Horde; history: HordeHistoryLike } {
      const horde = new Horde(50);
      horde.spawn(
        order({ waveId: 9, count: 20, formation: FORMATION.CLUSTER, anchorX: 3000, anchorY: 3000 }),
      );
      horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
      return { horde, history: new HordeHistoryLike(horde.capacity) };
    }

    interface HordeHistoryLikeState {
      count: number;
      x: Float32Array;
      y: Float32Array;
      vx: Float32Array;
      vy: Float32Array;
      archetype: Uint8Array;
      waveId: Uint16Array;
      indexInWave: Uint16Array;
      animPhase: Uint8Array;
      targetField: Uint8Array;
      stopped: Uint8Array;
    }

    class HordeHistoryLike {
      readonly #states = new Map<number, HordeHistoryLikeState>();
      constructor(private readonly capacity: number) {}
      record(tick: number, horde: Horde): void {
        const state: HordeHistoryLikeState = {
          count: 0,
          x: new Float32Array(this.capacity),
          y: new Float32Array(this.capacity),
          vx: new Float32Array(this.capacity),
          vy: new Float32Array(this.capacity),
          archetype: new Uint8Array(this.capacity),
          waveId: new Uint16Array(this.capacity),
          indexInWave: new Uint16Array(this.capacity),
          animPhase: new Uint8Array(this.capacity),
          targetField: new Uint8Array(this.capacity),
          stopped: new Uint8Array(this.capacity),
        };
        horde.saveState(state);
        this.#states.set(tick, state);
      }
      restore(tick: number, horde: Horde): boolean {
        const state = this.#states.get(tick);
        if (!state) {
          return false;
        }
        horde.restoreState(state);
        return true;
      }
    }

    const a = makeParticipant(); // « le serveur » : applique la mort a l'instant.
    const b = makeParticipant(); // « le client » : l'apprend 4 ticks plus tard, rejoue.

    const DEATH_TICK = 20;
    const DEATH_DELAY = 4;
    const deathId = a.horde.entityIdAt(0);
    const END = 60;

    for (let tick = 0; tick < END; tick++) {
      for (const p of [a, b]) {
        if (tick % stepsPerField === 0) {
          p.horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
        }
        p.horde.step(DT, fields, tick);
      }
      a.history.record(tick, a.horde);
      b.history.record(tick, b.horde);

      if (tick === DEATH_TICK) {
        a.horde.kill([deathId]);
      }
      if (tick === DEATH_TICK + DEATH_DELAY) {
        // `b` apprend la mort en retard : restaure au tick de la mort,
        // l'applique, rejoue jusqu'au present — exactement `applyDeathWithReplay`
        // de `horde.replication.test.ts`, en miniature.
        const restored = b.history.restore(DEATH_TICK, b.horde);
        expect(restored).toBe(true);
        b.horde.kill([deathId]);
        for (let t = DEATH_TICK + 1; t <= tick; t++) {
          if (t % stepsPerField === 0) {
            b.horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
          }
          b.horde.step(DT, fields, t);
        }
      }
    }

    expect(a.horde.count).toBe(b.horde.count);
    for (let i = 0; i < a.horde.count; i++) {
      expect(a.horde.entityIdAt(i)).toBe(b.horde.entityIdAt(i));
      // Le coeur du test : position ET vitesse tenue identiques, au bit pres.
      // Une vitesse restauree a zero (ou pas restauree du tout) ferait
      // diverger `x`/`y` au(x) pas suivant(s) — mais `vx`/`vy` eux-memes
      // divergeraient DEJA ici, avant meme que ca ne se voie sur la position.
      expect(b.horde.vx[i]).toBe(a.horde.vx[i]);
      expect(b.horde.vy[i]).toBe(a.horde.vy[i]);
      expect(b.horde.x[i]).toBe(a.horde.x[i]);
      expect(b.horde.y[i]).toBe(a.horde.y[i]);
    }
  });
});

function meanDistanceTo(horde: Horde, x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < horde.count; i++) {
    total += Math.hypot((horde.x[i] ?? 0) - x, (horde.y[i] ?? 0) - y);
  }
  return total / horde.count;
}
