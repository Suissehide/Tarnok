import { describe, expect, it } from 'vitest';

import { LINK_RADIUS, REACTION_RADIUS, ZONE_LIFETIME_TICKS, ZONE_RADIUS } from './constants';
import { ELEMENT } from './elements';
import { Horde } from './horde';
import { linkedNeighbours } from './links';
import { packZoneKind } from './protocol';
import { REACTION } from './reactions';
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
   * ⚠️ **Le coeur de la tache.** A-B a moins de `LINK_RADIUS`, B-C a moins de
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

  /**
   * ⚠️ **La borne stricte sur l'appartenance de `slot` LUI-MEME a la zone,
   * pas seulement sur celle des candidats.** Les deux moities du predicat
   * partagent la meme forme (`>= zoneR2` exclut le bord) ; sans ce test, une
   * mutation qui relacherait UNIQUEMENT la moitie « slot » (`>` au lieu de
   * `>=`) resterait verte, alors que la moitie « candidat » resterait
   * gardee par le test « chacun dans SA PROPRE zone » plus bas.
   */
  it('ne lie personne quand `slot` est pile sur le bord de la zone (borne stricte)', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    // Pile a ZONE_RADIUS du centre : sur le bord, donc DEHORS.
    spawnAt(horde, 1, ZONE_RADIUS, 0);
    // Bien a l'interieur, et a portee de liaison si `slot` comptait.
    spawnAt(horde, 2, ZONE_RADIUS - 10, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    expect(linkedNeighbours(horde, 0, zones, 0)).toEqual([]);
  });

  /**
   * ⚠️ **« Moins de `LINK_RADIUS` », donc la borne est STRICTE — meme
   * convention que `ZoneField.spawn` (fusion) et `nearestTarget`. Sans ce
   * test, une mutation qui relacherait `>= linkR2` en `> linkR2` resterait
   * verte : tous les autres tests de ce fichier mesurent des distances
   * franchement en-deca ou au-dela, jamais EXACTEMENT `LINK_RADIUS`.
   */
  it('ne lie pas a distance EXACTE de LINK_RADIUS : la borne est stricte', () => {
    const horde = new Horde();
    const zones = new ZoneField();
    spawnAt(horde, 1, -LINK_RADIUS / 2, 0);
    spawnAt(horde, 2, LINK_RADIUS / 2, 0);
    expect(horde.count).toBe(2);
    zones.spawn(ELEMENT.VIF_ARGENT, 0, 0, 0, 0);

    expect(linkedNeighbours(horde, 0, zones, 0)).toEqual([]);
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

  /**
   * ⚠️ **Le cas inverse de la revue post-tache 9 : une zone dont la PAIRE
   * ne contient pas le Vif-argent ne doit JAMAIS lier.** Supraconduction
   * (Givre + Foudre) ne pair pas le Vif-argent — sans ca, tout lierait.
   * Teste dans les DEUX ordres de declencheur, bien que le nibble
   * d'ELEMENT ne soit plus lu du tout par `zoneInvolvesVifArgent` : la
   * garde reste sur la PAIRE, jamais sur l'element, donc les deux ordres
   * doivent se comporter IDENTIQUEMENT — pas seulement l'un d'eux.
   */
  it('ne lie pas a travers une zone de REACTION dont la paire ne contient PAS le Vif-argent, quel que soit le declencheur', () => {
    const kindVifArgentDeclenche = packZoneKind(ELEMENT.VIF_ARGENT, REACTION.SUPRACONDUCTION);
    const kindAutreDeclenche = packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION);

    const hordeA = new Horde();
    const zonesA = new ZoneField();
    const a1 = spawnAt(hordeA, 1, 10, 0);
    const a2 = spawnAt(hordeA, 2, 30, 0);
    expect(hordeA.count).toBe(2);
    zonesA.spawn(kindVifArgentDeclenche, 0, 0, 0, 0);

    expect(linkedNeighbours(hordeA, 0, zonesA, 0)).not.toContain(a2);
    expect(linkedNeighbours(hordeA, 1, zonesA, 0)).not.toContain(a1);

    const hordeB = new Horde();
    const zonesB = new ZoneField();
    const b1 = spawnAt(hordeB, 1, 10, 0);
    const b2 = spawnAt(hordeB, 2, 30, 0);
    expect(hordeB.count).toBe(2);
    zonesB.spawn(kindAutreDeclenche, 0, 0, 0, 0);

    expect(linkedNeighbours(hordeB, 0, zonesB, 0)).not.toContain(b2);
    expect(linkedNeighbours(hordeB, 1, zonesB, 0)).not.toContain(b1);
  });

  /**
   * ⚠️ **Revue post-tache 9 : RENVERSE le test precedent de cette suite
   * (« Gel profond et Aveuglement ne lient jamais »).** Le filtre
   * `zoneReaction(kind) === 0` etait MORT en production (voir le docbloc du
   * module) : les CINQ reactions qui apparient le Vif-argent (Vaporisation,
   * Paratonnerre, Gel profond, Aveuglement, Amalgame) LIENT desormais,
   * `zoneInvolvesVifArgent` lisant leur PAIRE plutot que le nibble
   * d'element — ORDRE-INDEPENDANT par construction (`packElementPair`
   * canonicalise), teste ici dans les DEUX ordres de declencheur pour
   * chacune des cinq.
   *
   * ⚠️ **`w`, le temoin entre `LINK_RADIUS` (80) et `REACTION_RADIUS` (90)
   * — distingue la liaison du balayage GENERIQUE.** `w` partage la MEME
   * zone que `p1`/`p2` (tous a moins de `ZONE_RADIUS`, 70, du centre) mais
   * est a 85 px de `p1` : AU-DELA de `LINK_RADIUS`. Sans ce temoin, un
   * `linkedNeighbours` qui confondrait par erreur `LINK_RADIUS` avec
   * `REACTION_RADIUS` (le Choc thermique generique, plus large) resterait
   * indetectable par ce test — voir le brief, « LINK_RADIUS = 80 <
   * REACTION_RADIUS = 90 ».
   */
  it('les cinq reactions REELLES qui apparient le Vif-argent lient desormais, dans les deux ordres de declencheur', () => {
    const REACTIONS_VIF_ARGENT: ReadonlyArray<{ reaction: number; partner: number }> = [
      { reaction: REACTION.VAPORISATION, partner: ELEMENT.BRAISE },
      { reaction: REACTION.PARATONNERRE, partner: ELEMENT.FOUDRE },
      { reaction: REACTION.GEL_PROFOND, partner: ELEMENT.GIVRE },
      { reaction: REACTION.AVEUGLEMENT, partner: ELEMENT.CHAUX },
      { reaction: REACTION.AMALGAME, partner: ELEMENT.POIX },
    ];

    for (const { reaction, partner } of REACTIONS_VIF_ARGENT) {
      for (const declencheur of [ELEMENT.VIF_ARGENT, partner]) {
        const kind = packZoneKind(declencheur, reaction);
        const horde = new Horde();
        const zones = new ZoneField();
        const p1 = spawnAt(horde, 1, -40, 0);
        const p2 = spawnAt(horde, 2, -10, 0);
        const w = spawnAt(horde, 3, 45, 0);
        expect(horde.count).toBe(3);
        zones.spawn(kind, 0, 0, 0, 0);

        expect(30).toBeLessThan(LINK_RADIUS); // p1-p2 : lies
        expect(85).toBeGreaterThan(LINK_RADIUS); // p1-w : hors de LINK_RADIUS
        expect(85).toBeLessThan(REACTION_RADIUS); // ... mais DANS REACTION_RADIUS

        expect(linkedNeighbours(horde, 0, zones, 0), `reaction ${reaction}`).toContain(p2);
        expect(linkedNeighbours(horde, 1, zones, 0), `reaction ${reaction}`).toContain(p1);
        expect(linkedNeighbours(horde, 0, zones, 0), `reaction ${reaction}`).not.toContain(w);
      }
    }
  });
});
