import { describe, expect, it } from 'vitest';

import { ABSENT_BASE, baseStyle, UNIT_COLORS, UNIT_OF_CLASS, unitSheets } from './player-renderer';

describe('unitSheets — une unite par classe, une couleur par joueur', () => {
  it('la classe choisit l unite, le joueur la couleur', () => {
    expect(unitSheets(1, 1).idle).toBe('Units/Yellow%20Units/Warrior/Warrior_Idle.png');
    expect(unitSheets(2, 0).run).toBe('Units/Blue%20Units/Archer/Archer_Run.png');
    expect(unitSheets(3, 3).idle).toBe('Units/Red%20Units/Monk/Idle.png');
  });

  it('la lanciere a des images de 320, les autres de 192', () => {
    expect(unitSheets(1, 2).frame).toBe(320);
    expect(unitSheets(1, 0).frame).toBe(192);
  });

  it('quatre classes, quatre couleurs, et une classe inconnue retombe sur la premiere unite', () => {
    expect(UNIT_OF_CLASS).toHaveLength(4);
    expect(UNIT_COLORS).toHaveLength(4);
    expect(unitSheets(5, 99).idle).toBe('Units/Yellow%20Units/Archer/Archer_Idle.png');
  });
});

describe('etape 18 : le socle gris de l absent', () => {
  const COULEUR = 0xff8800;

  it('present : sa couleur, pleine pour soi, 0,7 pour un allie, 0,25 pour un mort', () => {
    expect(baseStyle(COULEUR, false, false, true)).toEqual({ color: COULEUR, alpha: 1 });
    expect(baseStyle(COULEUR, false, false, false)).toEqual({ color: COULEUR, alpha: 0.7 });
    expect(baseStyle(COULEUR, false, true, false)).toEqual({ color: COULEUR, alpha: 0.25 });
  });

  it('absent : le gris du totem, a l opacite du mort', () => {
    expect(baseStyle(COULEUR, true, false, false)).toEqual({ color: ABSENT_BASE, alpha: 0.25 });
    expect(ABSENT_BASE).toBe(0x8a8f99);
  });

  it('absent ET mort : le gris — l absence se lit meme au sol', () => {
    expect(baseStyle(COULEUR, true, true, false)).toEqual({ color: ABSENT_BASE, alpha: 0.25 });
  });
});
