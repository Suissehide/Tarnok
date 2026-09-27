import { describe, expect, it } from 'vitest';

import { LINK_RADIUS, ZONE_LIFETIME_TICKS } from './constants';
import { ELEMENT } from './elements';
import { Horde } from './horde';
import { linkedNeighbours } from './links';
import { FORMATION, type WaveOrder } from './waves';
import { ZoneField } from './zones';

/**
 * Meme convention que `shared/chain.test.ts` : un ordre minimal, une entite
 * a la fois, dont on ecrase la position juste apres `spawn` (formation
 * SCATTER, position aleatoire au depart) pour tenir une geometrie exacte.
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

/** Fait naitre une entite unique au slot suivant, avec une position choisie. */
function spawnAt(horde: Horde, waveId: number, x: number, y: number): number {
  const before = horde.count;
  horde.spawn(order({ waveId, count: 1 }));
  const slot = before;
  horde.x[slot] = x;
  horde.y[slot] = y;
  return horde.entityIdAt(slot);
}

describe('linkedNeighbours', () => {
  it('lie deux ennemis dans la meme zone de vif-argent et a portee', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    const a = spawnAt(horde, 1, 10, 0);
    const b = spawnAt(horde, 2, 50, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    expect(linkedNeighbours(horde, 0, zones, 0)).toEqual([b]);
    expect(linkedNeighbours(horde, 1, zones, 0)).toEqual([a]);
  });

  /**
   * ⚠️ **Le point de revue n° 2 du brief.** Son propre centre est a distance
   * NULLE de lui-meme, donc dans TOUT rayon. Sans exclusion explicite,
   * chaque ennemi serait lie a lui-meme et *Amalgame* (tache 7) le
   * frapperait deux fois pour un seul impact recu.
   *
   * ⚠️ **Horde reellement peuplee de DEUX entites, et ce n'est pas
   * accessoire** : avec une seule entite, un resultat vide passerait ce
   * test quelle que soit l'implementation (le decor qui renvoie zero). Le
   * voisin doit apparaitre dans le resultat pour que l'absence de `soi`
   * prouve l'exclusion plutot qu'un tableau vide par hasard.
   */
  it('un ennemi n est pas lie a lui-meme', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    const soi = spawnAt(horde, 1, 0, 0);
    const voisin = spawnAt(horde, 2, 20, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    const lies = linkedNeighbours(horde, 0, zones, 0);

    expect(lies).toEqual([voisin]);
    expect(lies).not.toContain(soi);
  });

  /**
   * ⚠️ **Le cœur de la tache.** A-B a moins de `LINK_RADIUS`, B-C a moins de
   * `LINK_RADIUS`, A-C au-dela : A et C ne sont PAS lies. Une fermeture
   * transitive (un amas) les aurait fusionnes par B, et le resultat aurait
   * alors dependu de l'ORDRE DE VISITE — donc du compactage de la horde, non
   * garanti identique des deux cotes du fil. Trois points colineaires, tous
   * a l'interieur de la MEME zone (rayon `ZONE_RADIUS`, 70) : A et C a 50 px
   * de B chacun (`< LINK_RADIUS`, 80), 100 px l'un de l'autre (`>=
   * LINK_RADIUS`).
   */
  it('la liaison n est PAS transitive', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    const a = spawnAt(horde, 1, -50, 0);
    const b = spawnAt(horde, 2, 0, 0);
    const c = spawnAt(horde, 3, 50, 0);
    expect(horde.count).toBe(3);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    const liesDeA = linkedNeighbours(horde, 0, zones, 0);
    const liesDeC = linkedNeighbours(horde, 2, zones, 0);

    expect(liesDeA).toEqual([b]);
    expect(liesDeC).toEqual([b]);
    expect(liesDeA).not.toContain(c);
    expect(liesDeC).not.toContain(a);
  });

  it('ne lie pas au-dela de LINK_RADIUS, meme dans la meme zone', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    // 60 px du centre chacun : a l'interieur de ZONE_RADIUS (70), a 120 px
    // l'un de l'autre — au-dela de LINK_RADIUS (80).
    spawnAt(horde, 1, -60, 0);
    spawnAt(horde, 2, 60, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    expect(linkedNeighbours(horde, 0, zones, 0)).toEqual([]);
    expect(linkedNeighbours(horde, 1, zones, 0)).toEqual([]);
  });

  /**
   * ⚠️ **Garde specifiquement « la MEME zone », pas « une zone de
   * Vif-argent chacun ».** Deux zones distinctes (centres a plus de
   * `ZONE_RADIUS` l'une de l'autre, donc jamais fusionnees par
   * `ZoneField.spawn`) : un ennemi pres du centre de chacune. Les deux
   * ennemis sont a moins de `LINK_RADIUS` l'un de l'autre en ligne droite,
   * mais AUCUNE zone ne les couvre tous les deux a la fois — une
   * implementation qui testerait seulement « chacun est dans une zone de
   * Vif-argent » les lierait a tort.
   */
  it('ne lie pas deux ennemis chacun dans SA PROPRE zone de vif-argent, sans zone commune', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    // A 30 px du centre de la premiere zone (dans ZONE_RADIUS, 70), a 70 px
    // du centre de la seconde (pile sur le bord, donc DEHORS).
    const a = spawnAt(horde, 1, 30, 0);
    // A 30 px du centre de la seconde zone, a 70 px du centre de la
    // premiere (pile sur le bord, donc DEHORS aussi).
    const b = spawnAt(horde, 2, 70, 0);
    expect(horde.count).toBe(2);
    // Distance a-b : 40 px, sous LINK_RADIUS (80) — proches en ligne droite.
    expect(Math.abs(70 - 30)).toBeLessThan(LINK_RADIUS);

    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);
    zones.spawn(ELEMENT.VIF_ARGENT, 100, 0, 0, 0);
    expect(zones.count).toBe(2);

    expect(linkedNeighbours(horde, 0, zones, 0)).not.toContain(b);
    expect(linkedNeighbours(horde, 1, zones, 0)).not.toContain(a);
  });

  it('ne lie pas a travers une zone qui ne porte pas le vif-argent', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    const a = spawnAt(horde, 1, 10, 0);
    const b = spawnAt(horde, 2, 30, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.BRAISE, 0, 0, 0, 0);

    expect(linkedNeighbours(horde, 0, zones, 0)).not.toContain(b);
    expect(linkedNeighbours(horde, 1, zones, 0)).not.toContain(a);
  });

  it('ne lie pas a travers une zone perimee', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    spawnAt(horde, 1, 10, 0);
    spawnAt(horde, 2, 30, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    // Encore vivante juste avant la peremption...
    expect(linkedNeighbours(horde, 0, zones, ZONE_LIFETIME_TICKS - 1)).not.toEqual([]);
    // ...perimee au tick de peremption exact, meme convention que
    // `ZoneField.aliveAt`.
    expect(linkedNeighbours(horde, 0, zones, ZONE_LIFETIME_TICKS)).toEqual([]);
  });

  it('rend un tableau vide quand la horde ne porte qu une seule entite', () => {
    // Ce test-ci vaut ce qu'il vaut sans son voisin ci-dessus : un resultat
    // vide seul ne prouve rien (le decor qui renvoie zero). Il complete la
    // couverture plutot que de s y substituer.
    const horde = new Horde();
    const zones = new ZoneField();
    spawnAt(horde, 1, 0, 0);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    expect(linkedNeighbours(horde, 0, zones, 0)).toEqual([]);
  });
});
