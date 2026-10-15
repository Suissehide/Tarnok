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
    // ⚠️ QUINZE tableaux (`fleeing` des voleurs compris), pas sept ni onze : c'est exactement le defaut R13
    // (voir le rapport de la tache 19) — un test qui n'en verifie qu'une
    // partie reste vert quand une copie manque dans `saveState`/`restoreState`.
    // `vx`/`vy` (tache 19), `hp` puis `mark`/`markBy`/`markUntil` (etape 5a)
    // sont ICI au meme titre que les autres, verifies un par un par corruption
    // puis restauration : supprimer la copie de l'UN QUELCONQUE de ces
    // quatorze tableaux dans `saveState` ou `restoreState` doit faire echouer
    // la ligne qui lui correspond, et elle seule.
    //
    // ⚠️ `hp` et la marque ne sont lus que par le serveur, qui ne rejoue
    // jamais — les laisser hors de l'instantane « marcherait » aujourd'hui.
    // C'est precisement pourquoi ils y sont : deux listes a tenir a jour au
    // lieu d'une, c'est la classe de defaut que ce depot paie le plus cher.
    //
    // ⚠️ Et une liste ecrite a la main vieillit. Le test verifie donc AUSSI
    // (`champsVerifies` plus bas) qu'elle couvre exactement les tableaux que
    // porte l'instance — meme garde que le test « emmene toutes les
    // proprietes » de `horde.test.ts`, pour la meme raison.
    const horde = new Horde(20);
    horde.spawn(order({ waveId: 1, archetype: 2, count: 3 }));
    // Valeurs distinctives, posees a la main : le spawn seul ne fait pas
    // varier x/y/vx/vy/targetField assez pour prouver qu'ils sont bien copies.
    horde.x[0] = 111.5;
    horde.y[0] = 222.5;
    horde.vx[0] = 45.5;
    horde.vy[0] = -67.5;
    horde.targetField[0] = 3;
    horde.stopped[0] = 1;
    horde.fleeing[0] = 1;
    horde.hp[0] = 13.5;
    horde.mark[0] = 2;
    horde.markBy[0] = 3;
    horde.markUntil[0] = 4242;

    horde.aimX = [10, 20];
    horde.aimY = [30, 40];
    const history = new HordeHistory(horde.capacity);
    history.record(5, horde);

    const attendu = {
      count: horde.count,
      x: horde.x[0] ?? 0,
      y: horde.y[0] ?? 0,
      vx: horde.vx[0] ?? 0,
      vy: horde.vy[0] ?? 0,
      archetype: horde.archetype[0] ?? 0,
      waveId: horde.waveId[0] ?? 0,
      indexInWave: horde.indexInWave[0] ?? 0,
      animPhase: horde.animPhase[0] ?? 0,
      targetField: horde.targetField[0] ?? 0,
      stopped: horde.stopped[0] ?? 0,
      fleeing: horde.fleeing[0] ?? 0,
      hp: horde.hp[0] ?? 0,
      mark: horde.mark[0] ?? 0,
      markBy: horde.markBy[0] ?? 0,
      markUntil: horde.markUntil[0] ?? 0,
    };

    // La liste ci-dessus couvre-t-elle bien TOUS les tableaux de l'instance ?
    // Ajouter un tableau a `Horde` sans l'ajouter ici fait rougir cette ligne,
    // au lieu de laisser un instantane incomplet passer inapercu jusqu'a ce
    // qu'un rejeu s'appuie dessus.
    const champsVerifies = Object.keys(attendu).filter((cle) => cle !== 'count');
    const tableauxDeLInstance = Object.keys(horde as unknown as Record<string, unknown>).filter(
      (cle) => ArrayBuffer.isView((horde as unknown as Record<string, unknown>)[cle]),
    );
    expect(champsVerifies.slice().sort()).toEqual(tableauxDeLInstance.slice().sort());

    // Corrompt CHAQUE champ individuellement, avec une valeur differente de
    // celle sauvegardee, plus le compte (via kill sur une AUTRE entite, pour
    // ne pas perturber le creneau 0 par compaction).
    horde.x[0] = 999.5;
    horde.y[0] = 888.5;
    horde.vx[0] = -12.5;
    horde.vy[0] = 34.5;
    horde.archetype[0] = (attendu.archetype + 1) % 256;
    horde.waveId[0] = attendu.waveId + 1;
    horde.indexInWave[0] = attendu.indexInWave + 1;
    horde.animPhase[0] = (attendu.animPhase + 1) % 256;
    horde.targetField[0] = (attendu.targetField + 1) % 4;
    horde.stopped[0] = attendu.stopped === 1 ? 0 : 1;
    horde.fleeing[0] = attendu.fleeing === 1 ? 0 : 1;
    horde.hp[0] = attendu.hp + 1;
    horde.mark[0] = (attendu.mark + 1) % 256;
    horde.markBy[0] = (attendu.markBy + 1) % 256;
    horde.markUntil[0] = attendu.markUntil + 1;
    horde.aimX = [99];
    horde.aimY = [99];
    horde.kill([horde.entityIdAt(horde.count - 1)]);
    expect(horde.count).toBe(attendu.count - 1); // sanity : le compte a bien change

    const ok = history.restore(5, horde);

    expect(ok).toBe(true);
    expect(horde.count).toBe(attendu.count);
    expect(horde.x[0]).toBe(attendu.x);
    expect(horde.y[0]).toBe(attendu.y);
    expect(horde.vx[0]).toBe(attendu.vx);
    expect(horde.vy[0]).toBe(attendu.vy);
    expect(horde.archetype[0]).toBe(attendu.archetype);
    expect(horde.waveId[0]).toBe(attendu.waveId);
    expect(horde.indexInWave[0]).toBe(attendu.indexInWave);
    expect(horde.animPhase[0]).toBe(attendu.animPhase);
    expect(horde.targetField[0]).toBe(attendu.targetField);
    expect(horde.stopped[0]).toBe(attendu.stopped);
    expect(horde.fleeing[0]).toBe(attendu.fleeing);
    expect(horde.hp[0]).toBe(attendu.hp);
    expect(horde.mark[0]).toBe(attendu.mark);
    expect(horde.markBy[0]).toBe(attendu.markBy);
    expect(horde.markUntil[0]).toBe(attendu.markUntil);
    // Les positions visees du gardien (hors tableaux types, donc verifiees a part).
    expect(horde.aimX).toEqual([10, 20]);
    expect(horde.aimY).toEqual([30, 40]);
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
