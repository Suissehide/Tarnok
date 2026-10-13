import { describe, expect, it } from 'vitest';

import { ramp } from './skin';

describe('ramp : la tuile se raccorde a elle-meme', () => {
  it('la derniere colonne rejoint la premiere, l alpha et le transparent restent intacts', () => {
    // Une ligne de 3 pixels opaques (10 -> 40 en rouge) et une ligne dont le
    // premier pixel est transparent : celle-la ne doit pas bouger.
    const px = new Uint8ClampedArray([
      10, 0, 0, 255, 20, 0, 0, 255, 40, 0, 0, 255, 0, 0, 0, 0, 50, 0, 0, 255, 90, 0, 0, 255,
    ]);
    ramp(px, 3, 2);
    expect([px[0], px[4], px[8]]).toEqual([10, 5, 10]);
    expect([px[3], px[7], px[11]]).toEqual([255, 255, 255]);
    expect([px[16], px[20]]).toEqual([50, 90]);
  });
});
