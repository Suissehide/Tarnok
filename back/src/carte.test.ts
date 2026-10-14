import { FLOWFIELD_CELL, MAP_SIZE, TICK_HZ } from '@shared/constants';
import { FlowField } from '@shared/flowfield';
import { generateWorld, TERRAIN } from '@shared/worldmap';
import { describe, expect, it } from 'vitest';

import { Room } from './room';

const DT = 1 / TICK_HZ;

/**
 * Le salon fait buter les joueurs sur le decor de SA carte (`moveOnMap`) — le
 * meme masque que le champ de flux. `worldmap.test.ts` garde la regle, ce
 * fichier garde le CABLAGE.
 */
describe('les joueurs ne marchent pas sur l eau', () => {
  it('un joueur qui court vers l est s arrete au rivage', () => {
    const room = new Room(11);
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const world = generateWorld(room.mapSeed, probe.cols, probe.rows);
    // La rangee du milieu : la premiere cellule d'eau a l'est du centre.
    const cy = Math.floor(probe.rows / 2);
    let cx = Math.floor(probe.cols / 2);
    while (world.terrain[cy * probe.cols + cx] !== TERRAIN.WATER) {
      cx++;
    }
    const rivage = cx * FLOWFIELD_CELL;

    room.join(1);
    room.debugPlace(1, rivage - 3 * FLOWFIELD_CELL, cy * FLOWFIELD_CELL + FLOWFIELD_CELL / 2);
    for (let i = 0; i < 3 * TICK_HZ; i++) {
      room.applyInput(1, i + 1, 127, 0);
      room.step(DT);
    }
    const x = room.positionOf(1)?.x ?? Number.POSITIVE_INFINITY;
    expect(x).toBeLessThan(rivage);
    // Et il a bien couru jusque-la : sans mouvement, le test ne prouverait rien.
    expect(x).toBeGreaterThan(rivage - 2 * FLOWFIELD_CELL);
  });
});
