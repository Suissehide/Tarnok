import { describe, expect, it } from 'vitest';

import { FIELD_INPUT_DELAY_TICKS } from './constants';
import { PlayerHistory } from './player-history';

describe('PlayerHistory', () => {
  it('rend les positions du tick retarde, pas celles du tick courant', () => {
    const h = new PlayerHistory();
    for (let tick = 0; tick <= 10; tick++) {
      h.record(tick, [tick * 100], [0]);
    }

    const vu = h.delayed(10);

    expect(vu?.x[0]).toBe((10 - FIELD_INPUT_DELAY_TICKS) * 100);
    expect(vu?.tick).toBe(10 - FIELD_INPUT_DELAY_TICKS);
  });

  it("rend null tant que l'historique n'est pas assez profond", () => {
    const h = new PlayerHistory();
    h.record(0, [0], [0]);

    expect(h.delayed(0)).toBeNull();
  });

  it('ne garde pas un historique sans fin', () => {
    const h = new PlayerHistory();
    for (let tick = 0; tick < 5000; tick++) {
      h.record(tick, [tick], [tick]);
    }

    expect(h.size).toBeLessThanOrEqual(16);
  });

  it('rend le meme resultat aux deux bouts : c est tout le point', () => {
    // Le serveur enregistre a chaque tick ; le client enregistre a la reception
    // des snapshots. Tant que le tick demande est present des deux cotes, ils
    // lisent la meme chose.
    const serveur = new PlayerHistory();
    const client = new PlayerHistory();
    for (let tick = 0; tick <= 20; tick++) {
      serveur.record(tick, [tick * 10, tick * 5], [0, 0]);
    }
    // Le client a recu les memes snapshots, avec du retard.
    for (let tick = 0; tick <= 20; tick++) {
      client.record(tick, [tick * 10, tick * 5], [0, 0]);
    }

    expect(client.delayed(18)).toEqual(serveur.delayed(18));
  });

  it("s'accroche au dernier connu quand les snapshots recents manquent", () => {
    const h = new PlayerHistory();
    // Le client n'enregistre qu'a la reception d'un snapshot : ici, plus rien
    // n'arrive apres le tick 10, alors que la horde continue d'avancer.
    for (let tick = 0; tick <= 10; tick++) {
      h.record(tick, [tick * 100], [0]);
    }

    // Au tick 20, on voudrait le tick 17 — jamais enregistre. On s'accroche au
    // plus recent disponible plutot que de figer la horde.
    expect(h.delayed(20)?.x[0]).toBe(1000);
    // Et ce tick de repli doit etre annonce tel quel : 10, pas 17.
    expect(h.delayed(20)?.tick).toBe(10);
  });
});
