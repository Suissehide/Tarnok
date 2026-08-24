import { describe, expect, it } from 'vitest';

import { MAX_ENTITIES } from './constants';
import { FlowField } from './flowfield';
import { entityIdOf, Horde } from './horde';
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
    // ⚠️ Les SEPT tableaux sont verifies, un par un. Une premiere version de ce
    // test n'en verifiait que deux — `archetype` et `animPhase` — alors que son
    // nom promet « pas seulement sa position ». Verifie : supprimer la copie de
    // `x`, de `y` ou de `targetField` laissait les 26 tests verts.
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
    const attendu = {
      entityId: horde.entityIdAt(last),
      x: horde.x[last],
      y: horde.y[last],
      archetype: horde.archetype[last],
      waveId: horde.waveId[last],
      indexInWave: horde.indexInWave[last],
      animPhase: horde.animPhase[last],
      targetField: horde.targetField[last],
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

function meanDistanceTo(horde: Horde, x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < horde.count; i++) {
    total += Math.hypot((horde.x[i] ?? 0) - x, (horde.y[i] ?? 0) - y);
  }
  return total / horde.count;
}
