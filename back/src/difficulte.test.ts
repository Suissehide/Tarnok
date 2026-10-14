import { TICK_HZ } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { Room } from './room';
import { RAMP_LEVELS } from './wave-director';

const DT = 1 / TICK_HZ;

/**
 * La difficulte suit le NIVEAU de l'equipe et son NOMBRE de joueurs, mesuree
 * au salon : `WaveDirector` est garde par `wave-director.test.ts`, ce fichier
 * garde le CABLAGE — `Room` lui passe-t-il vraiment son niveau et ses joueurs ?
 */
function premiereVague(joueurs: number, level: number): number {
  const room = new Room(7);
  for (let id = 1; id <= joueurs; id++) {
    room.join(id);
  }
  room.debugSetLevel(level);
  for (let i = 0; i < 20 * TICK_HZ; i++) {
    room.step(DT);
    if (room.horde.count > 0) {
      return room.horde.count;
    }
  }
  throw new Error('aucune vague en vingt secondes');
}

describe('le salon passe son niveau et ses joueurs au directeur de vagues', () => {
  it('a joueurs egaux, une equipe de plus haut niveau recoit une vague plus grande', () => {
    expect(premiereVague(1, RAMP_LEVELS)).toBeGreaterThan(premiereVague(1, 1));
  });

  it('a niveau egal, quatre joueurs recoivent une vague plus grande qu un seul', () => {
    expect(premiereVague(4, RAMP_LEVELS)).toBeGreaterThan(premiereVague(1, RAMP_LEVELS));
  });
});
