import { describe, expect, it } from 'vitest';

import { CONTACT_RADIUS, FLOWFIELD_HZ, MAX_ENTITIES, TICK_HZ } from './constants';
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
      horde.step(DT, fields);
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
        h.step(DT, fields);
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
      horde.step(DT, fields);
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
    horde.step(DT, fields);

    // Aucun `update` sur les champs depuis ce `step` : le rattrapage voit les
    // memes revisions qu'au dernier pas, comme dans l'ordre correct d'un tick.
    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).not.toThrow();
  });

  it('precede par un rafraichissement du champ, leve — et le message parle de l ordre', () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);

    horde.step(DT, fields);
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
      horde.step(DT, fields);
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
      horde.step(DT, fields);
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
        horde.step(DT, fields);
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
    // ⚠️ Les HUIT tableaux sont verifies, un par un (`stopped` depuis la
    // tache 17.2). Une premiere version de ce test n'en verifiait que deux —
    // `archetype` et `animPhase` — alors que son nom promet « pas seulement sa
    // position ». Verifie : supprimer la copie de `x`, de `y` ou de
    // `targetField` laissait les 26 tests verts.
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
    horde.targetField[last] = 3;
    horde.stopped[last] = 1;
    const attendu = {
      entityId: horde.entityIdAt(last),
      x: horde.x[last],
      y: horde.y[last],
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
      horde.step(DT, fields);
      const cell = field.indexAt(horde.x[0] ?? 0, horde.y[0] ?? 0);
      if (field.blocked[cell] === 0) {
        escaped = true;
        break;
      }
    }

    expect(escaped).toBe(true);
  });
});

function meanDistanceTo(horde: Horde, x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < horde.count; i++) {
    total += Math.hypot((horde.x[i] ?? 0) - x, (horde.y[i] ?? 0) - y);
  }
  return total / horde.count;
}
