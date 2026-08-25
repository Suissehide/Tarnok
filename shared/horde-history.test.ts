import { describe, expect, it } from 'vitest';

import { ROLLBACK_DEPTH_TICKS } from './constants';
import { Horde } from './horde';
import { HordeHistory } from './horde-history';
import { FORMATION, type WaveOrder } from './waves';

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

describe('HordeHistory', () => {
  it('un aller-retour enregistrer / restaurer rend exactement l etat sauvegarde, champ par champ', () => {
    const horde = new Horde(20);
    horde.spawn(order({ waveId: 1, archetype: 2, count: 3 }));
    // Valeurs distinctives, posees a la main : le spawn seul ne fait pas
    // varier x/y/targetField assez pour prouver qu'ils sont bien copies.
    horde.x[0] = 111.5;
    horde.y[0] = 222.5;
    horde.targetField[0] = 3;
    horde.stopped[0] = 1;

    const history = new HordeHistory(horde.capacity);
    history.record(5, horde);

    const attendu = {
      count: horde.count,
      x: horde.x[0] ?? 0,
      y: horde.y[0] ?? 0,
      archetype: horde.archetype[0] ?? 0,
      waveId: horde.waveId[0] ?? 0,
      indexInWave: horde.indexInWave[0] ?? 0,
      animPhase: horde.animPhase[0] ?? 0,
      targetField: horde.targetField[0] ?? 0,
      stopped: horde.stopped[0] ?? 0,
    };

    // Corrompt CHAQUE champ individuellement, avec une valeur differente de
    // celle sauvegardee, plus le compte (via kill sur une AUTRE entite, pour
    // ne pas perturber le creneau 0 par compaction).
    horde.x[0] = 999.5;
    horde.y[0] = 888.5;
    horde.archetype[0] = (attendu.archetype + 1) % 256;
    horde.waveId[0] = attendu.waveId + 1;
    horde.indexInWave[0] = attendu.indexInWave + 1;
    horde.animPhase[0] = (attendu.animPhase + 1) % 256;
    horde.targetField[0] = (attendu.targetField + 1) % 4;
    horde.stopped[0] = attendu.stopped === 1 ? 0 : 1;
    horde.kill([horde.entityIdAt(horde.count - 1)]);
    expect(horde.count).toBe(attendu.count - 1); // sanity : le compte a bien change

    const ok = history.restore(5, horde);

    expect(ok).toBe(true);
    expect(horde.count).toBe(attendu.count);
    expect(horde.x[0]).toBe(attendu.x);
    expect(horde.y[0]).toBe(attendu.y);
    expect(horde.archetype[0]).toBe(attendu.archetype);
    expect(horde.waveId[0]).toBe(attendu.waveId);
    expect(horde.indexInWave[0]).toBe(attendu.indexInWave);
    expect(horde.animPhase[0]).toBe(attendu.animPhase);
    expect(horde.targetField[0]).toBe(attendu.targetField);
    expect(horde.stopped[0]).toBe(attendu.stopped);
  });

  it('restaurer un tick jamais enregistre rend false et ne modifie pas la horde', () => {
    const horde = new Horde(20);
    horde.spawn(order({ count: 5 }));
    horde.x[0] = 42;
    const history = new HordeHistory(horde.capacity);
    // Un enregistrement existe (tick 1, creneau different de 99 % profondeur)
    // pour prouver que le refus vient bien du controle de tick, pas d'un
    // anneau simplement vide.
    history.record(1, horde);

    const avantCount = horde.count;
    const avantX = horde.x[0];

    const ok = history.restore(99, horde);

    expect(ok).toBe(false);
    // Si le controle de tick manquait, restore appliquerait l'etat vierge du
    // creneau 99 % ROLLBACK_DEPTH_TICKS (jamais ecrit) : compte a 0, x a 0.
    // Ces assertions prouvent que ca ne s'est PAS produit.
    expect(horde.count).toBe(avantCount);
    expect(horde.x[0]).toBe(avantX);
  });

  it('l anneau ne garde que ROLLBACK_DEPTH_TICKS etats : les plus vieux sont perdus', () => {
    const horde = new Horde(20);
    horde.spawn(order({ count: 5 }));
    const history = new HordeHistory(horde.capacity);

    const totalTicks = ROLLBACK_DEPTH_TICKS + 3;
    for (let tick = 0; tick < totalTicks; tick++) {
      history.record(tick, horde);
    }

    const scratch = new Horde(20);
    for (let tick = 0; tick < totalTicks - ROLLBACK_DEPTH_TICKS; tick++) {
      expect(history.restore(tick, scratch)).toBe(false);
    }
    for (let tick = totalTicks - ROLLBACK_DEPTH_TICKS; tick < totalTicks; tick++) {
      expect(history.restore(tick, scratch)).toBe(true);
    }
    expect(history.oldestTick()).toBe(totalTicks - ROLLBACK_DEPTH_TICKS);
  });

  it('un aller-retour enregistrer / tuer / restaurer redonne l entite tuee', () => {
    const horde = new Horde(20);
    horde.spawn(order({ waveId: 7, count: 5 }));
    const cible = horde.entityIdAt(2);
    const history = new HordeHistory(horde.capacity);

    history.record(3, horde);
    horde.kill([cible]);
    expect(horde.slotOf(cible)).toBe(-1); // sanity : bien tuee avant restore

    const ok = history.restore(3, horde);

    expect(ok).toBe(true);
    expect(horde.count).toBe(5);
    expect(horde.slotOf(cible)).not.toBe(-1);
  });
});
