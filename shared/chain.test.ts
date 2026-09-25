import { describe, expect, it } from 'vitest';

import { chainTargets } from './chain';
import { entityIdOf, Horde } from './horde';
import { FORMATION, type WaveOrder } from './waves';

/**
 * Meme convention que `shared/horde.test.ts` : un ordre minimal, une entite
 * a la fois, dont on ecrase la position juste apres `spawn` (formation
 * SCATTER, position aleatoire au depart) pour tenir une geometrie exacte —
 * le meme motif que les tests de `#applyDeoverlap`/`#recomputeSteering`
 * dans `shared/horde.test.ts` (`horde.x[0] = 100`, etc).
 */
function order(overrides: Partial<WaveOrder> = {}): WaveOrder {
  return {
    waveId: 1,
    spawnTick: 0,
    seed: 0x1234,
    archetype: 0,
    formation: FORMATION.SCATTER,
    anchorX: 1000,
    anchorY: 1000,
    count: 1,
    ...overrides,
  };
}

/** Fait naitre une entite unique au slot `slot`, avec une position choisie. */
function spawnAt(horde: Horde, waveId: number, x: number, y: number): number {
  const before = horde.count;
  horde.spawn(order({ waveId, count: 1 }));
  const slot = before;
  horde.x[slot] = x;
  horde.y[slot] = y;
  return horde.entityIdAt(slot);
}

describe('chainTargets', () => {
  it('rend l entite la plus proche du point d impact, a portee', () => {
    const horde = new Horde();
    const proche = spawnAt(horde, 1, 10, 0);
    const moyenne = spawnAt(horde, 2, 50, 0);
    const loin = spawnAt(horde, 3, 200, 0);
    // Horde reellement peuplee, et ce n'est pas accessoire : un decor vide
    // rendrait [] quelle que soit l'implementation.
    expect(horde.count).toBe(3);

    const cibles = chainTargets(horde, 0, 0, 100, 1, new Set());

    expect(cibles).toEqual([proche]);
    expect(cibles).not.toContain(moyenne);
    expect(cibles).not.toContain(loin);
  });

  it('rend jusqu a `jumps` cibles, triees de la plus proche a la plus lointaine', () => {
    const horde = new Horde();
    const a = spawnAt(horde, 1, 10, 0);
    const b = spawnAt(horde, 2, 30, 0);
    const c = spawnAt(horde, 3, 60, 0);
    const d = spawnAt(horde, 4, 90, 0);
    expect(horde.count).toBe(4);

    const cibles = chainTargets(horde, 0, 0, 100, 2, new Set());

    expect(cibles).toEqual([a, b]);
    expect(cibles).not.toContain(c);
    expect(cibles).not.toContain(d);
  });

  it('ne depasse jamais `jumps` meme si davantage de cibles sont a portee', () => {
    const horde = new Horde();
    spawnAt(horde, 1, 10, 0);
    spawnAt(horde, 2, 20, 0);
    spawnAt(horde, 3, 30, 0);
    expect(horde.count).toBe(3);

    const cibles = chainTargets(horde, 0, 0, 100, 2, new Set());

    expect(cibles.length).toBe(2);
  });

  it('rend MOINS de `jumps` cibles si la horde n en offre pas assez a portee — un plafond, pas une promesse', () => {
    const horde = new Horde();
    const seule = spawnAt(horde, 1, 10, 0);
    spawnAt(horde, 2, 500, 0); // tres hors de portee
    expect(horde.count).toBe(2);

    const cibles = chainTargets(horde, 0, 0, 100, 5, new Set());

    expect(cibles).toEqual([seule]);
  });

  it('exclut toute cible hors du rayon, meme si `jumps` le permettrait', () => {
    const horde = new Horde();
    const dedans = spawnAt(horde, 1, 10, 0);
    const dehors = spawnAt(horde, 2, 200, 0);
    expect(horde.count).toBe(2);

    const cibles = chainTargets(horde, 0, 0, 100, 5, new Set());

    expect(cibles).toEqual([dedans]);
    expect(cibles).not.toContain(dehors);
  });

  it('inclut une cible pile a la limite du rayon (borne inclusive, meme convention que nearestTarget)', () => {
    const horde = new Horde();
    const pileALaLimite = spawnAt(horde, 1, 100, 0); // d2 = 100^2 = r2 exactement
    expect(horde.count).toBe(1);

    const cibles = chainTargets(horde, 0, 0, 100, 1, new Set());

    expect(cibles).toEqual([pileALaLimite]);
  });

  it('exclut une cible juste hors de la limite du rayon', () => {
    const horde = new Horde();
    spawnAt(horde, 1, 101, 0);
    expect(horde.count).toBe(1);

    const cibles = chainTargets(horde, 0, 0, 100, 1, new Set());

    expect(cibles).toEqual([]);
  });

  it('respecte `exclude` : une entite exclue n est jamais choisie, meme seule a portee', () => {
    const horde = new Horde();
    const exclue = spawnAt(horde, 1, 10, 0);
    const autre = spawnAt(horde, 2, 20, 0);
    expect(horde.count).toBe(2);

    const cibles = chainTargets(horde, 0, 0, 100, 5, new Set([exclue]));

    expect(cibles).toEqual([autre]);
  });

  it('rend [] pour `jumps` nul ou negatif, sur une horde pourtant peuplee et a portee', () => {
    // ⚠️ DEUX candidats a portee, pas un seul : `[].slice(0, -1)` sur un
    // tableau d'UN SEUL element rend deja [] par accident (index -1 ==
    // longueur - 1 == 0), donc un decor a un seul candidat ne distingue pas
    // la garde `jumps <= 0` d'un simple defaut de `Array.prototype.slice`.
    // Avec deux candidats, `slice(0, -1)` sans la garde rendrait UNE cible —
    // c'est ce qui rend ce test capable de la voir disparaitre.
    const horde = new Horde();
    spawnAt(horde, 1, 10, 0);
    spawnAt(horde, 2, 20, 0);
    expect(horde.count).toBe(2);

    expect(chainTargets(horde, 0, 0, 100, 0, new Set())).toEqual([]);
    expect(chainTargets(horde, 0, 0, 100, -1, new Set())).toEqual([]);
  });

  /**
   * ⚠️ **LE test de la tache.** Deux ennemis symetriques autour du point
   * d'impact : meme distance au bit pres (`50 * 50` est calcule de la meme
   * facon des deux cotes, aucune divergence flottante possible). L'ordre
   * d'iteration ne peut PAS trancher — il depend du compactage de la horde
   * (`Horde#removeAt` echange avec le dernier element), qui n'est PAS
   * garanti identique entre le serveur et un client, ni entre deux clients.
   * Un seul saut disponible : la chaine doit choisir le MEME des deux, quel
   * que soit l'ordre dans lequel ils ont ete places dans le tableau — pose
   * ici deux fois, avec les deux ordres d'insertion, pour le prouver plutot
   * que de le supposer.
   */
  describe('departage deux ennemis a distance strictement egale par entityId', () => {
    it('ordre d insertion 1 : le petit identifiant est place en premier', () => {
      const horde = new Horde();
      // wave 1 nait en premier -> occupe le slot 0 -> porte le PLUS PETIT id.
      const petit = spawnAt(horde, 1, -50, 0);
      const grand = spawnAt(horde, 2, 50, 0);
      expect(petit).toBeLessThan(grand);
      expect(horde.count).toBe(2);

      const cibles = chainTargets(horde, 0, 0, 100, 1, new Set());

      expect(cibles).toEqual([petit]);
    });

    it('ordre d insertion 2 : le petit identifiant est place en second (horde compactee dans l autre sens)', () => {
      const horde = new Horde();
      // wave 2 nait en premier -> occupe le slot 0 -> porte le PLUS GRAND id.
      // Meme geometrie physique que le test precedent (petit id a -50,0 ;
      // grand id a 50,0), mais l'ordre du TABLEAU est invers .
      const grand = spawnAt(horde, 2, 50, 0);
      const petit = spawnAt(horde, 1, -50, 0);
      expect(petit).toBeLessThan(grand);
      expect(horde.count).toBe(2);

      const cibles = chainTargets(horde, 0, 0, 100, 1, new Set());

      // Meme resultat que l'ordre 1 : c'est entityId qui departage, jamais
      // le slot.
      expect(cibles).toEqual([petit]);
    });
  });

  it('est deterministe : deux appels identiques sur le meme etat rendent exactement la meme liste', () => {
    const horde = new Horde();
    spawnAt(horde, 1, 10, 0);
    spawnAt(horde, 2, 20, 0);
    spawnAt(horde, 3, 30, 0);
    expect(horde.count).toBe(3);

    const premier = chainTargets(horde, 0, 0, 100, 3, new Set());
    const second = chainTargets(horde, 0, 0, 100, 3, new Set());

    expect(second).toEqual(premier);
    expect(premier.length).toBe(3);
  });
});

describe('entityIdOf (sanity — les ids utilises par ce fichier ne se chevauchent pas entre vagues)', () => {
  it('la vague 1 rend toujours un id plus petit que la vague 2, quel que soit l index', () => {
    expect(entityIdOf(1, 0)).toBeLessThan(entityIdOf(2, 0));
  });
});
