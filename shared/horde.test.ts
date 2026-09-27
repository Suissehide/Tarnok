import { describe, expect, it } from 'vitest';

import { ARCHETYPES, archetypeOf, HEAVY_HP, LIGHT_HP } from './archetypes';
import { chargeHoldsAt, chargePointAt, makeBossCharge } from './boss';
import {
  COIN_DROP_ONE_IN,
  COIN_DROP_RESIDUE,
  CONTACT_RADIUS,
  DEOVERLAP_MAX_PX,
  FLOWFIELD_HZ,
  MARK_DURATION_TICKS,
  MAX_ENTITIES,
  MAX_PER_WAVE,
  ORB_DROP_ONE_IN,
  SEPARATION_RADIUS,
  STEERING_RECOMPUTE_TICKS,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
  TICK_HZ,
  VERGLAS_INERTIA_DAMPING,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { FlowField } from './flowfield';
import { dropsCoin, dropsOrb, entityIdOf, Horde, type HordeState, leavesDrop } from './horde';
import { PlayerHistory } from './player-history';
import { packZoneKind } from './protocol';
import { REACTION } from './reactions';
import { FORMATION, type WaveOrder } from './waves';
import { applyObstacles, generateObstacles } from './worldmap';
import { ZoneField } from './zones';

const DT = 1 / 30;

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

function fieldsTowards(x: number, y: number): FlowField[] {
  return Array.from({ length: 4 }, () => {
    const f = new FlowField(6000, 64);
    f.update(x, y);
    return f;
  });
}

describe('entityIdOf', () => {
  it('ne produit jamais deux fois le meme identifiant', () => {
    const ids = new Set<number>();
    for (let wave = 0; wave < 50; wave++) {
      for (let i = 0; i < 100; i++) {
        ids.add(entityIdOf(wave, i));
      }
    }

    expect(ids.size).toBe(50 * 100);
  });

  it('ne recycle pas : la vague 2 ne reprend pas les identifiants de la vague 1', () => {
    expect(entityIdOf(2, 0)).toBeGreaterThan(entityIdOf(1, 4095));
  });
});

/**
 * Etape 5a, tache 17 : *« moins d'xp qui tombe »*. Le taux de chute est le
 * levier du NOMBRE D'OBJETS AU SOL, et il doit se calculer identiquement des
 * deux cotes du fil — le serveur arbitre le ramassage, mais il n'annonce jamais
 * qu'un orbe existe : le client le derive du seul `DEATHS`.
 */
describe('dropsOrb — quelles morts laissent un orbe', () => {
  /**
   * ⚠️ **Exactement une sur `ORB_DROP_ONE_IN`, pas « une sur quatre en
   * moyenne ».** C'est ce qui laisse l'experience par mort strictement
   * inchangee malgre la rarefaction (voir `XP_PER_ORB`), au lieu de la laisser
   * flotter d'une run a l'autre.
   */
  it('retient exactement une identite sur ORB_DROP_ONE_IN, sur des index consecutifs', () => {
    const total = 400;
    let retenues = 0;
    for (let i = 0; i < total; i++) {
      if (dropsOrb(entityIdOf(7, i))) {
        retenues++;
      }
    }

    expect(retenues).toBe(total / ORB_DROP_ONE_IN);
  });

  /**
   * ⚠️ **Le meme verdict d'une vague a l'autre**, parce que `MAX_PER_WAVE` est
   * un multiple de `ORB_DROP_ONE_IN`. Si ce n'etait pas le cas, le taux reel
   * derivarait d'une vague a l'autre — et le decor d'un test, lui, ne le
   * verrait jamais.
   */
  it('donne le meme verdict pour un meme index, quelle que soit la vague', () => {
    expect(MAX_PER_WAVE % ORB_DROP_ONE_IN).toBe(0);
    for (let index = 0; index < 2 * ORB_DROP_ONE_IN; index++) {
      const attendu = dropsOrb(entityIdOf(0, index));
      for (const wave of [1, 17, 250, 4095]) {
        expect(dropsOrb(entityIdOf(wave, index))).toBe(attendu);
      }
    }
  });

  /**
   * ⚠️ **Le piege du decor, garde ici plutot que rappele en commentaire** : un
   * test qui pose son monstre avec `entityIdOf(waveId, 0)` tombe TOUJOURS sur
   * un orbe. C'est la « fixture qui masque » du depot, et la raison pour
   * laquelle les tests du taux de chute balaient des index CONSECUTIFS.
   */
  it('laisse toujours un orbe au premier de chaque vague — le decor qui masque', () => {
    for (const wave of [0, 1, 600, 4095]) {
      expect(dropsOrb(entityIdOf(wave, 0))).toBe(true);
    }
  });
});

/**
 * Etape 6a, tache 14 : *« les monstres ne droppent pas d'or j'ai
 * l'impression »*. Meme modele que `dropsOrb`, et pour la meme raison : le
 * serveur credite l'or, mais il n'annonce jamais qu'une piece existe — le
 * client la derive du seul `DEATHS`, et `PICKUPS` ne transporte que des
 * identites nues.
 */
describe('dropsCoin — quelles morts laissent une piece', () => {
  it('retient exactement une identite sur COIN_DROP_ONE_IN, sur des index consecutifs', () => {
    const total = 1600;
    let retenues = 0;
    for (let i = 0; i < total; i++) {
      if (dropsCoin(entityIdOf(7, i))) {
        retenues++;
      }
    }

    expect(retenues).toBe(total / COIN_DROP_ONE_IN);
    // ⚠️ **Plus RARE que l'orbe, et c'est la demande** : *« une piece doit etre
    // un evenement, pas du bruit au sol »*. Ecrit comme une relation, jamais
    // comme deux nombres a comparer de tete.
    expect(COIN_DROP_ONE_IN).toBeGreaterThan(ORB_DROP_ONE_IN);
  });

  it('donne le meme verdict pour un meme index, quelle que soit la vague', () => {
    expect(MAX_PER_WAVE % COIN_DROP_ONE_IN).toBe(0);
    for (let index = 0; index < 2 * COIN_DROP_ONE_IN; index++) {
      const attendu = dropsCoin(entityIdOf(0, index));
      for (const wave of [1, 17, 250, 4095]) {
        expect(dropsCoin(entityIdOf(wave, index))).toBe(attendu);
      }
    }
  });

  /**
   * ⚠️ **LES DEUX NATURES SONT DISJOINTES, et c'est ce qui rend `PICKUPS`
   * lisible sans un octet de plus.** Le message transporte des identites nues ;
   * chaque cote sait si ce qui a ete ramasse valait de l'experience ou de l'or
   * **parce qu'aucune identite ne peut valoir les deux**. Un
   * `COIN_DROP_RESIDUE` a zero — ou a n'importe quel multiple de
   * `ORB_DROP_ONE_IN` — rendrait toute piece egalement orbe, et le message
   * ambigu.
   */
  it('ne partage AUCUNE identite avec dropsOrb', () => {
    let orbes = 0;
    let pieces = 0;
    for (let i = 0; i < 1600; i++) {
      const id = entityIdOf(7, i);
      expect(dropsOrb(id) && dropsCoin(id), `identite ${id}`).toBe(false);
      expect(leavesDrop(id)).toBe(dropsOrb(id) || dropsCoin(id));
      if (dropsOrb(id)) {
        orbes++;
      }
      if (dropsCoin(id)) {
        pieces++;
      }
    }
    // Non-vacuite : les deux ensembles sont non vides, sinon « disjoints » est
    // vrai pour rien.
    expect(orbes).toBeGreaterThan(0);
    expect(pieces).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **Le piege du decor, en MIROIR de celui des orbes** : un test qui pose
   * son monstre a `entityIdOf(waveId, 0)` ne tombe JAMAIS sur une piece, la ou
   * il tombait toujours sur une orbe. Un decor bati sur l'index 0 est donc
   * aveugle a cette tache entiere.
   */
  it('ne laisse JAMAIS de piece au premier de chaque vague — le decor qui masque', () => {
    for (const wave of [0, 1, 600, 4095]) {
      expect(dropsCoin(entityIdOf(wave, 0))).toBe(false);
    }
    // Et il y en a bien une, un peu plus loin dans la meme vague.
    expect(dropsCoin(entityIdOf(600, COIN_DROP_RESIDUE))).toBe(true);
  });
});

describe('Horde.spawn', () => {
  it('ajoute exactement le nombre demande', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 250 }));

    expect(horde.count).toBe(250);
  });

  it('cumule les vagues', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 100 }));
    horde.spawn(order({ waveId: 2, count: 150 }));

    expect(horde.count).toBe(250);
  });

  it('donne a chaque entite son identite et son archetype', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 3, archetype: 2, count: 10 }));

    expect(horde.entityIdAt(0)).toBe(entityIdOf(3, 0));
    expect(horde.archetype[0]).toBe(2);
  });

  /**
   * Etape 5a : la reserve de PV se DERIVE de l'archetype, donc les deux cotes
   * la posent identiquement sans un octet de plus sur le fil. Deux archetypes
   * de PV differents dans le meme test : une mutation qui poserait une
   * constante (`this.hp[slot] = 5`) au lieu de lire l'archetype passerait avec
   * un seul.
   */
  it('remplit les PV depuis l archetype, pas depuis une constante', () => {
    const leger = ARCHETYPES.find((a) => a.hp === LIGHT_HP);
    const lourd = ARCHETYPES.find((a) => a.hp === HEAVY_HP);
    expect(leger).toBeDefined();
    expect(lourd).toBeDefined();

    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, archetype: leger?.id ?? 0, count: 3 }));
    horde.spawn(order({ waveId: 2, archetype: lourd?.id ?? 0, count: 3 }));

    expect([...horde.hp.slice(0, 3)]).toEqual([LIGHT_HP, LIGHT_HP, LIGHT_HP]);
    expect([...horde.hp.slice(3, 6)]).toEqual([HEAVY_HP, HEAVY_HP, HEAVY_HP]);
  });

  /**
   * ⚠️ Meme raison que `targetField` et `stopped` : un creneau recycle apres
   * une mort doit repartir a PLEINE reserve. Sans l'ecriture inconditionnelle
   * dans `spawn`, une entite neuve heriterait des PV entames du monstre qu'elle
   * remplace — et mourrait au premier coup en se faisant passer pour une
   * pietaille lourde.
   */
  it('rend ses PV pleins a un creneau recycle apres une mort', () => {
    const lourd = ARCHETYPES.find((a) => a.hp === HEAVY_HP);
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, archetype: lourd?.id ?? 0, count: 2 }));
    horde.hp[0] = 1; // entame par un projectile
    horde.hp[1] = 2;
    horde.kill([horde.entityIdAt(0), horde.entityIdAt(1)]);
    expect(horde.count).toBe(0);

    horde.spawn(order({ waveId: 2, archetype: lourd?.id ?? 0, count: 2 }));

    expect([...horde.hp.slice(0, 2)]).toEqual([HEAVY_HP, HEAVY_HP]);
  });

  it('disperse les phases d animation : mille crânes ne marchent pas au pas', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 300 }));

    const phases = new Set([...horde.animPhase.slice(0, 300)]);
    expect(phases.size).toBeGreaterThan(3);
  });

  it('refuse de depasser sa capacite au lieu de deborder', () => {
    const horde = new Horde(100);
    horde.spawn(order({ count: 80 }));
    horde.spawn(order({ waveId: 2, count: 80 }));

    expect(horde.count).toBe(100);
  });

  it('prend MAX_ENTITIES comme capacite par defaut, pour que deux simulations tronquent pareil', () => {
    expect(new Horde().capacity).toBe(MAX_ENTITIES);
  });
});

describe('Horde.step', () => {
  it('fait converger la horde vers la cible du champ', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 100, anchorX: 1000, anchorY: 1000 }));
    const fields = fieldsTowards(4000, 4000);
    horde.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);

    const avant = meanDistanceTo(horde, 4000, 4000);
    for (let i = 0; i < 300; i++) {
      horde.step(DT, fields, i);
    }

    expect(meanDistanceTo(horde, 4000, 4000)).toBeLessThan(avant - 500);
  });

  it('est deterministe : deux hordes, memes ordres, memes positions', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);
    for (const h of [a, b]) {
      h.spawn(order({ count: 200 }));
      h.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);
      for (let i = 0; i < 200; i++) {
        h.step(DT, fields, i);
      }
    }

    expect([...a.x.slice(0, 200)]).toEqual([...b.x.slice(0, 200)]);
  });

  it('ne sort pas de la carte', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 100 }));
    const fields = fieldsTowards(0, 0);
    horde.retarget([0, 0, 0, 0], [0, 0, 0, 0]);
    for (let i = 0; i < 2000; i++) {
      horde.step(DT, fields, i);
    }

    for (let i = 0; i < horde.count; i++) {
      expect(horde.x[i]).toBeGreaterThanOrEqual(0);
      expect(horde.y[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Horde.spawnCatchingUp', () => {
  it('avec missedTicks a zero, donne exactement le meme resultat que spawn', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);

    a.spawn(order({ count: 100 }));
    b.spawnCatchingUp(order({ count: 100 }), 0, DT, fields);

    expect(a.count).toBe(b.count);
    expect([...a.x.slice(0, 100)]).toEqual([...b.x.slice(0, 100)]);
    expect([...a.y.slice(0, 100)]).toEqual([...b.y.slice(0, 100)]);
  });

  it('avec missedTicks positif, les nouvelles entites sont plus avancees', () => {
    const fields = fieldsTowards(4000, 4000);
    const rattrape = new Horde(1000);
    const normal = new Horde(1000);

    rattrape.spawnCatchingUp(order({ count: 100, anchorX: 1000, anchorY: 1000 }), 2, DT, fields);
    normal.spawn(order({ count: 100, anchorX: 1000, anchorY: 1000 }));

    const avantRattrape = meanDistanceTo(rattrape, 4000, 4000);
    const avantNormal = meanDistanceTo(normal, 4000, 4000);

    expect(avantRattrape).toBeLessThan(avantNormal);
  });

  it("n'affecte pas les entites deja presentes", () => {
    // Mutation visee (tache 20) : appeler `#recomputeSteering` sur la plage
    // ENTIERE (`[0, #count)`) plutot que restreinte a `[before, #count)` dans
    // `spawnCatchingUp` — les entites de la vague 1, deja presentes, se
    // verraient recalculer une trajectoire (et donc une vitesse non nulle)
    // au passage d'un rattrapage qui ne les concerne pourtant pas.
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 50, anchorX: 1000, anchorY: 1000 }));
    const fields = fieldsTowards(1000, 1000);
    horde.retarget([1000, 1000, 1000, 1000], [1000, 1000, 1000, 1000]);

    const avantX = [...horde.x.slice(0, 50)];
    const avantY = [...horde.y.slice(0, 50)];
    const avantVx = [...horde.vx.slice(0, 50)];
    const avantVy = [...horde.vy.slice(0, 50)];

    horde.spawnCatchingUp(
      order({ waveId: 2, count: 50, anchorX: 5000, anchorY: 5000 }),
      5,
      DT,
      fields,
    );

    expect([...horde.x.slice(0, 50)]).toEqual(avantX);
    expect([...horde.y.slice(0, 50)]).toEqual(avantY);
    // Position ET vitesse (tache 20) : une entite recalculee a tort par le
    // rattrapage garderait la MEME position ce tick-la (le recalcul ne fait
    // que poser `vx`/`vy`, `#advanceByVelocity` n'est jamais appele sur
    // cette plage) mais pas la meme vitesse — verifier seulement x/y laisse
    // ce defaut passer inapercu.
    expect([...horde.vx.slice(0, 50)]).toEqual(avantVx);
    expect([...horde.vy.slice(0, 50)]).toEqual(avantVy);
  });

  it('produit le meme nombre d entites que spawn, rattrapage ou non', () => {
    const fields = fieldsTowards(4000, 4000);
    const a = new Horde(1000);
    const b = new Horde(1000);

    a.spawn(order({ count: 100 }));
    b.spawnCatchingUp(order({ count: 100 }), 3, DT, fields);

    expect(b.count).toBe(a.count);
  });
});

describe('Horde.spawnCatchingUp — garde-fou de fraicheur des champs', () => {
  it("dans l'ordre correct (rattrapage avant le rafraichissement du tick), ne leve pas", () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);

    // `step` a deja tourne au moins une fois : la horde est « avancee ».
    horde.step(DT, fields, 0);

    // Aucun `update` sur les champs depuis ce `step` : le rattrapage voit les
    // memes revisions qu'au dernier pas, comme dans l'ordre correct d'un tick.
    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).not.toThrow();
  });

  it('precede par un rafraichissement du champ, leve — et le message parle de l ordre', () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);

    horde.step(DT, fields, 0);
    // Rafraichissement periodique du tick, appele — a tort — avant le
    // rattrapage plutot qu'apres.
    fields[0]?.update(1000, 1000);

    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).toThrow(/avant tout appel a FlowField\.update/);
  });

  it('sur une horde jamais avancee (tout premier ordre), ne leve pas', () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);
    // Un rafraichissement a deja eu lieu, mais `step` n'a encore jamais
    // tourne : rien n'a ete releve, donc rien a comparer.
    fields[0]?.update(1000, 1000);

    expect(() => {
      horde.spawnCatchingUp(order({ count: 50 }), 2, DT, fields);
    }).not.toThrow();
  });

  it("n'affecte pas le comportement nominal de step", () => {
    const horde = new Horde(1000);
    const fields = fieldsTowards(4000, 4000);
    horde.spawn(order({ count: 50 }));
    horde.retarget([4000, 4000, 4000, 4000], [4000, 4000, 4000, 4000]);

    const avant = meanDistanceTo(horde, 4000, 4000);
    for (let i = 0; i < 100; i++) {
      horde.step(DT, fields, i);
    }

    expect(meanDistanceTo(horde, 4000, 4000)).toBeLessThan(avant);
  });
});

describe('Horde.retarget', () => {
  it('envoie chaque entite vers le joueur le plus proche', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 100;
    horde.y[0] = 100;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    horde.retarget([0, 5900], [0, 5900]);

    expect(horde.targetField[0]).toBe(0);
    expect(horde.targetField[1]).toBe(1);
  });

  /**
   * Tache 17.2 : l'arret au contact se decide ICI, dans `retarget` — au meme
   * endroit et a la meme cadence que le reciblage, a partir des positions
   * DEJA retardees que l'appelant lui passe (§5 de la spec, voir
   * `PlayerHistory.delayed`). `Horde` ne sait rien du reseau ; il ne fait que
   * comparer sa propre position, deja identique des deux cotes par
   * construction, a celle qu'on lui donne.
   */
  it('marque une entite arretee quand son joueur le plus proche est a portee de contact', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 100;
    horde.y[0] = 100;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    // Le joueur associe a l'entite 0 est colle a elle ; celui associe a
    // l'entite 1 en reste tres eloigne.
    horde.retarget([100, 5900], [100, 5900]);

    expect(horde.stopped[0]).toBe(1);
    expect(horde.stopped[1]).toBe(0);
  });

  /**
   * Fixe la portee d'arret sur `CONTACT_RADIUS` precisement — pas sur un
   * nombre invente a cote (`SEPARATION_RADIUS`, `PROJECTILE_HIT_RADIUS`, ou
   * une constante propre qui se degraderait sans jamais suivre l'arbitrage
   * serveur). Une entite juste EN DECA doit s'arreter, une entite juste
   * AU-DELA doit continuer d'avancer.
   */
  it("utilise CONTACT_RADIUS comme portee d'arret, pas un nombre invente a cote", () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = 1000;
    horde.y[0] = 1000;
    horde.x[1] = 5000;
    horde.y[1] = 5000;

    horde.retarget([1000 + CONTACT_RADIUS - 1, 5000 + CONTACT_RADIUS + 1], [1000, 5000]);

    expect(horde.stopped[0]).toBe(1);
    expect(horde.stopped[1]).toBe(0);
  });
});

/**
 * Tache 17.2 : une entite arretee cesse d'avancer, meme si le champ continue
 * de la tirer fort ailleurs — sans quoi elle traverserait quand meme le
 * joueur, exactement le defaut remonte en jeu.
 */
describe('Horde.step laisse une entite arretee sur place', () => {
  it("une entite marquee arretee (retarget) n'avance plus, meme apres plusieurs pas", () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
    horde.x[0] = 1000;
    horde.y[0] = 1000;
    // Champ qui tire fortement ailleurs : si le garde-fou d'arret manquait,
    // l'entite s'en rapprocherait visiblement en 100 pas.
    const fields = fieldsTowards(4000, 4000);

    // Le joueur cible est colle a l'entite : elle doit s'arreter des ce
    // reciblage.
    horde.retarget([1000, 1000, 1000, 1000], [1000, 1000, 1000, 1000]);
    expect(horde.stopped[0]).toBe(1); // sanity : le garde teste bien un cas arrete

    const beforeX = horde.x[0];
    const beforeY = horde.y[0];
    for (let i = 0; i < 100; i++) {
      horde.step(DT, fields, i);
    }

    expect(horde.x[0]).toBe(beforeX);
    expect(horde.y[0]).toBe(beforeY);
  });
});

/**
 * Tache 17.2, garde-fou explicitement demande par le brief : « un monstre
 * arrive a portee cesse d'avancer, et les deux cotes s'arretent au meme
 * tick ». Rejoue la boucle production (`PlayerHistory.record/delayed`,
 * `retarget` a la cadence du flowfield, `step` a chaque tick — exactement le
 * montage de `Room.step` et `GameClient#advanceHorde`) deux fois de suite,
 * sur deux graphes d'objets independants, et verifie que :
 *  - le monstre a REELLEMENT avance avant de s'arreter (sinon le test ne
 *    prouverait rien : une horde immobile depuis le premier tick "s'arrete"
 *    trivialement) ;
 *  - il s'arrete au MEME tick des deux cotes ;
 *  - il reste immobile apres.
 */
describe("Horde s'arrete au contact de facon deterministe", () => {
  it('un monstre qui approche cesse d avancer une fois a portee, au meme tick des deux simulations', () => {
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const MAP = 6000;
    const CELL = 64;
    // Le joueur marche vers (TARGET_X, FIXED_Y) pendant RAMP_TICKS puis s'y
    // IMMOBILISE : sans palier final, un joueur qui continue tout droit finit
    // par depasser un monstre deja a l'arret et rouvre la distance — ce n'est
    // pas un defaut (l'arret n'a pas a etre un cliquet : un monstre distance
    // doit pouvoir se remettre a poursuivre), mais ca rendrait ce test
    // instable pour une raison etrangere a ce qu'il verifie. Voir le rapport
    // de la tache 17 pour la mesure qui a fait choisir ce palier.
    const TOTAL_TICKS = 500;
    const RAMP_TICKS = 200;
    const START_X = 0;
    const TARGET_X = 2500;
    const FIXED_Y = 3000;

    interface RunResult {
      /** Tick de la DERNIERE transition 0 -> 1 : celle qui tient jusqu'a la fin. */
      stopTick: number;
      positions: { x: number; y: number }[];
    }

    function playerXAt(tick: number): number {
      const t = Math.min(1, tick / RAMP_TICKS);
      return START_X + (TARGET_X - START_X) * t;
    }

    function run(): RunResult {
      const horde = new Horde(4);
      horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
      // Position fixe et connue : la formation SCATTER disperse sur 900 px,
      // ce que ce test n'a pas besoin de negocier.
      horde.x[0] = 3000;
      horde.y[0] = FIXED_Y;

      const fields = [new FlowField(MAP, CELL)];
      const history = new PlayerHistory();
      const positions: { x: number; y: number }[] = [];
      let stopTick = -1;
      let wasStopped = false;

      for (let tick = 0; tick < TOTAL_TICKS; tick++) {
        history.record(tick, [playerXAt(tick)], [FIXED_Y]);
        if (tick % stepsPerField === 0) {
          const seen = history.delayed(tick);
          if (seen) {
            fields[0]?.update(seen.x[0] ?? 0, seen.y[0] ?? 0);
            horde.retarget(seen.x, seen.y);
          }
        }
        horde.step(DT, fields, tick);
        positions.push({ x: horde.x[0] ?? 0, y: horde.y[0] ?? 0 });
        const isStopped = horde.stopped[0] === 1;
        if (isStopped && !wasStopped) {
          stopTick = tick;
        }
        wasStopped = isStopped;
      }

      return { stopTick, positions };
    }

    const a = run();
    const b = run();

    expect(a.stopTick).toBeGreaterThan(0);
    expect(a.stopTick).toBe(b.stopTick);

    // Elle a REELLEMENT avance avant de s'arreter : sans cette assertion, une
    // horde immobile depuis le premier tick « s'arreterait » trivialement et
    // le test ne prouverait rien.
    const early = a.positions[5] ?? { x: 0, y: 0 };
    const justBefore = a.positions[a.stopTick - 1] ?? early;
    expect(Math.hypot(justBefore.x - early.x, justBefore.y - early.y)).toBeGreaterThan(50);

    // Et elle reste immobile jusqu'au bout une fois arretee pour de bon.
    const atStop = a.positions[a.stopTick] ?? { x: 0, y: 0 };
    const atEnd = a.positions[a.positions.length - 1] ?? atStop;
    expect(atEnd.x).toBe(atStop.x);
    expect(atEnd.y).toBe(atStop.y);
  });
});

describe('Horde.kill', () => {
  it('retire les entites demandees', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, count: 10 }));
    const cible = horde.entityIdAt(3);

    expect(horde.kill([cible])).toBe(1);
    expect(horde.count).toBe(9);
    expect(horde.slotOf(cible)).toBe(-1);
  });

  it('ignore une identite inconnue sans planter', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 5 }));

    expect(horde.kill([999_999])).toBe(0);
    expect(horde.count).toBe(5);
  });

  // ⚠️ Note sur le test ci-dessous : il compare deux executions du MEME code,
  // donc il prouve qu'un tri deterministe existe, pas qu'il est decroissant.
  // C'est « preserve toutes les entites survivantes » qui porte cette
  // exigence — verifie : passer le tri en croissant le fait echouer, et lui
  // seul. Les deux se tiennent ; ne pas supprimer l'un en gardant l'autre.
  it('donne le meme resultat quel que soit l ordre de la liste', () => {
    // Le protocole trie les identites, mais rien n'empeche un appelant de
    // passer une liste desordonnee : le resultat doit etre identique, sinon
    // deux clients compacteraient differemment.
    const a = new Horde(1000);
    const b = new Horde(1000);
    a.spawn(order({ count: 20 }));
    b.spawn(order({ count: 20 }));
    const ids = [a.entityIdAt(2), a.entityIdAt(7), a.entityIdAt(15)];

    a.kill(ids);
    b.kill([...ids].reverse());

    const idsDe = (h: Horde): number[] =>
      Array.from({ length: h.count }, (_, i) => h.entityIdAt(i));
    expect(idsDe(a)).toEqual(idsDe(b));
  });

  it('ne retire qu une fois une identite listee deux fois', () => {
    // Rien dans le protocole ne garantit l'unicite : deux armes qui achevent la
    // meme entite au meme tick peuvent l'inscrire deux fois dans le lot. Sans
    // garde, la seconde passe supprime l'entite vivante deplacee dans le trou.
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const cible = horde.entityIdAt(3);
    const survivants = new Set(
      Array.from({ length: 10 }, (_, i) => horde.entityIdAt(i)).filter((id) => id !== cible),
    );

    expect(horde.kill([cible, cible])).toBe(1);
    expect(horde.count).toBe(9);

    const apres = new Set(Array.from({ length: horde.count }, (_, i) => horde.entityIdAt(i)));
    expect(apres).toEqual(survivants);
  });

  it('preserve toutes les entites survivantes', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const avant = new Set(Array.from({ length: 10 }, (_, i) => horde.entityIdAt(i)));
    const morts = [horde.entityIdAt(0), horde.entityIdAt(9)];

    horde.kill(morts);

    const apres = new Set(Array.from({ length: horde.count }, (_, i) => horde.entityIdAt(i)));
    for (const id of avant) {
      expect(apres.has(id)).toBe(!morts.includes(id));
    }
  });

  /**
   * Les tableaux que `#removeAt` doit recopier, **enumeres depuis une liste
   * unique**.
   *
   * ⚠️ **Le piege connu de ce depot.** A l'etape 3, le test qui portait ce nom
   * verifiait DEUX tableaux sur sept : supprimer la copie de `x`, de `y` ou de
   * `targetField` laissait la suite verte. L'entite deplacee dans le creneau
   * libere gardait alors une propriete du mort qu'elle remplace — a l'etape
   * 5a, ses PV entames, donc un monstre qui meurt d'un coup au lieu de quatre
   * ou l'inverse, ou **la marque elementaire du mort**, donc un ennemi indemne
   * qui declenche une reaction et une charge de Synergie pour un element que
   * personne ne lui a applique.
   *
   * Une liste ecrite a la main ne suffit pas : elle vieillit. Le test verifie
   * donc AUSSI qu'elle couvre exactement les tableaux que porte l'instance
   * (`tableauxDe`) — ajouter un tableau a `Horde` sans l'ajouter ici fait
   * rougir la couverture, et l'ajouter ici sans l'ajouter a `#removeAt` fait
   * rougir la copie. Compter les lignes de `#removeAt` serait fragile ;
   * comparer aux proprietes de l'instance ne l'est pas.
   */
  const CHAMPS = [
    'x',
    'y',
    'vx',
    'vy',
    'archetype',
    'waveId',
    'indexInWave',
    'animPhase',
    'targetField',
    'stopped',
    'hp',
    'mark',
    'markBy',
    'markUntil',
  ] as const;

  /** Les noms des proprietes de `horde` qui sont des tableaux types. */
  function tableauxDe(horde: Horde): string[] {
    const vue = horde as unknown as Record<string, unknown>;
    return Object.keys(vue)
      .filter((cle) => ArrayBuffer.isView(vue[cle]))
      .sort();
  }

  /** Acces indexe generique aux tableaux publics, pour boucler sur `CHAMPS`. */
  function tableau(
    horde: Horde,
    champ: (typeof CHAMPS)[number],
  ): Float32Array | Float64Array | Uint8Array | Uint16Array {
    return horde[champ];
  }

  it('emmene toutes les proprietes de l entite deplacee, pas seulement sa position', () => {
    const horde = new Horde(1000);
    horde.spawn(order({ waveId: 1, archetype: 0, count: 5 }));
    horde.spawn(order({ waveId: 2, archetype: 3, count: 5 }));

    // 1. La liste couvre bien TOUT ce que l'instance porte.
    expect(tableauxDe(horde)).toEqual([...CHAMPS].sort());

    // 2. Valeurs distinctives sur l'entite qui va etre deplacee : deux entites
    //    qui partagent deja une valeur ne prouveraient rien d'une copie
    //    manquante. Toutes tiennent sur un `Uint8Array`, le plus etroit des
    //    trois types en jeu.
    const last = horde.count - 1;
    CHAMPS.forEach((champ, i) => {
      tableau(horde, champ)[last] = 100 + i;
    });
    const attendu = new Map<string, number>(
      CHAMPS.map((champ) => [champ, tableau(horde, champ)[last] ?? 0]),
    );
    const entityId = horde.entityIdAt(last);

    // 3. La VICTIME porte une valeur differente sur chaque champ — sans ca,
    //    une copie manquante serait masquee par une coincidence de fixture.
    for (const champ of CHAMPS) {
      expect(tableau(horde, champ)[0]).not.toBe(attendu.get(champ));
    }

    horde.kill([horde.entityIdAt(0)]);

    const slot = horde.slotOf(entityId);
    expect(slot).toBe(0);
    for (const champ of CHAMPS) {
      expect(tableau(horde, champ)[slot], `champ ${champ}`).toBe(attendu.get(champ));
    }
  });

  it('ignore une identite inconnue melangee a une connue', () => {
    // ⚠️ C'est le seul cas qui rende le filtre `slot >= 0` porteur. Avec une
    // identite inconnue SEULE, le garde de doublon la confond avec `previous`
    // initialise a -1 et masque le defaut par hasard : la mutation passe. Une
    // inconnue melangee a une connue ne beneficie plus de cette coincidence.
    //
    // Sans le filtre, `#removeAt(-1)` decremente `#count` en ecrivant dans le
    // vide — l'ecriture a un indice negatif sur un tableau type est un no-op
    // silencieux — et une entite vivante disparait du compte.
    const horde = new Horde(1000);
    horde.spawn(order({ count: 10 }));
    const cible = horde.entityIdAt(4);

    expect(horde.kill([cible, 999_999])).toBe(1);
    expect(horde.count).toBe(9);
    expect(horde.slotOf(cible)).toBe(-1);
  });
});

describe('tache 18 : pas de naissance en plein mur, sortie d un mur garantie', () => {
  it('Horde.spawn evite les cellules murees quand on lui passe un champ', () => {
    const field = new FlowField(6000, 64);
    // Un pate de mur autour de l'ancre, assez large pour que plusieurs des
    // positions SCATTER calculees SANS le champ y tombent directement (verifie
    // par la premiere boucle ci-dessous).
    const anchorCol = field.indexAt(1000, 1000) % field.cols;
    const anchorRow = Math.floor(field.indexAt(1000, 1000) / field.cols);
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        field.block(anchorCol + dx, anchorRow + dy);
      }
    }
    field.update(1000, 1000); // cible hors du pate, sans effet sur `blocked`

    const withoutObstacles = new Horde(500);
    withoutObstacles.spawn(order({ count: 400, anchorX: 1000, anchorY: 1000 }));
    let rawInWall = 0;
    for (let i = 0; i < withoutObstacles.count; i++) {
      const cell = field.indexAt(withoutObstacles.x[i] ?? 0, withoutObstacles.y[i] ?? 0);
      if (field.blocked[cell] === 1) {
        rawInWall++;
      }
    }
    // Le test ne prouverait rien si le pate de mur, par accident, ne genait
    // aucune position brute.
    expect(rawInWall).toBeGreaterThan(0);

    const withObstacles = new Horde(500);
    withObstacles.spawn(order({ count: 400, anchorX: 1000, anchorY: 1000 }), field);
    for (let i = 0; i < withObstacles.count; i++) {
      const cell = field.indexAt(withObstacles.x[i] ?? 0, withObstacles.y[i] ?? 0);
      expect(field.blocked[cell]).toBe(0);
    }
  });

  it('une entite coincee dans un mur en ressort au bout de quelques pas de Horde.step', () => {
    const field = new FlowField(6000, 64);
    // Un mur epais de 3 cellules entre l'entite et la cible : sans la sortie
    // de secours (tache 18), la cellule centrale ne porterait aucune
    // direction et l'entite y resterait figee pour toujours.
    const startCol = field.indexAt(1000, 1000) % field.cols;
    const startRow = Math.floor(field.indexAt(1000, 1000) / field.cols);
    for (let k = 0; k < 3; k++) {
      field.block(startCol + k, startRow);
    }
    field.update(3000, 1000);
    const fields = [field, field, field, field];

    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: 5000, anchorY: 5000 })); // loin du mur, position ecrasee juste apres
    // Centre de la cellule bloquee du milieu (colonne startCol+1, ligne
    // startRow). ⚠️ Piege verifie a la main lors de l'ecriture de ce test :
    // une premiere version utilisait la MEME formule pour x et y (1000 + 32),
    // ce qui place l'entite ligne startRow+1 — jamais bloquee — et le test
    // passait meme avec la sortie de secours desactivee, sans rien prouver.
    // D'ou l'assertion de precondition juste en dessous.
    horde.x[0] = (startCol + 1 + 0.5) * 64;
    horde.y[0] = (startRow + 0.5) * 64;
    expect(field.blocked[field.indexAt(horde.x[0] ?? 0, horde.y[0] ?? 0)]).toBe(1);

    let escaped = false;
    for (let t = 0; t < 60; t++) {
      horde.step(DT, fields, t);
      const cell = field.indexAt(horde.x[0] ?? 0, horde.y[0] ?? 0);
      if (field.blocked[cell] === 0) {
        escaped = true;
        break;
      }
    }

    expect(escaped).toBe(true);
  });
});

describe('tache 19 : recalcul de trajectoire par intervalle', () => {
  it('step avec dt <= 0 est un NO-OP STRICT, y compris pour vx/vy (rejoue le gel cote client)', () => {
    // Mutation visee : `if (dt > 0) { ... }` retire de `Horde.step`. Rejoue
    // exactement l'asymetrie gel decrite dans sa doc : le serveur (`Room.step`)
    // ne rappelle JAMAIS `horde.step` pendant le gel strict (retour anticipe
    // avant meme de calculer `scaledDt`), alors que `GameClient#advanceHorde`
    // l'appelle quand meme avec `dt * 0`. Si `dt <= 0` recalculait quand meme
    // `vx`/`vy`, le « client » ci-dessous partirait de la reprise avec une
    // vitesse que le « serveur » n'a jamais posee.
    const serveur = new Horde(10);
    const client = new Horde(10);
    for (const h of [serveur, client]) {
      h.spawn(order({ count: 5, formation: FORMATION.CLUSTER, anchorX: 3000, anchorY: 3000 }));
    }
    const fields = fieldsTowards(6000, 3000);
    for (const h of [serveur, client]) {
      h.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
    }

    const AVANT_GEL = 5;
    const GEL = 20; // largement > K, pour laisser le temps a un recalcul errone de se produire.
    for (let tick = 0; tick < AVANT_GEL; tick++) {
      for (const h of [serveur, client]) {
        h.step(DT, fields, tick);
      }
    }

    // Pendant le « gel » : le serveur SAUTE l'appel (comme `Room.step`), le
    // client l'appelle quand meme avec `dt = 0` (comme `GameClient#advanceHorde`).
    for (let tick = AVANT_GEL; tick < AVANT_GEL + GEL; tick++) {
      client.step(0, fields, tick);
    }

    // La reprise : les deux doivent repartir du MEME etat, vitesse comprise.
    for (let tick = AVANT_GEL + GEL; tick < AVANT_GEL + GEL + 5; tick++) {
      for (const h of [serveur, client]) {
        h.step(DT, fields, tick);
      }
    }

    for (let i = 0; i < serveur.count; i++) {
      expect(client.vx[i]).toBe(serveur.vx[i]);
      expect(client.vy[i]).toBe(serveur.vy[i]);
      expect(client.x[i]).toBe(serveur.x[i]);
      expect(client.y[i]).toBe(serveur.y[i]);
    }
  });

  it('la vitesse est TENUE entre deux recalculs : elle ne bouge pas quand le champ change entre-temps', () => {
    // Mutation visee : un recalcul qui aurait lieu a CHAQUE tick plutot qu'un
    // tick sur K. Une seule entite, sans voisin (repulsion nulle par
    // construction), pour que la seule source de changement de vx/vy soit le
    // recalcul lui-meme.
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
    // Centre EXACT d'une cellule de flowfield (64 px) sur les deux axes
    // (tache 25) : depuis l'interpolation bilineaire, une position
    // quelconque a l'interieur d'une cellule ne rend plus forcement la meme
    // direction que le centre de cette cellule — seul le centre exact
    // degenere en la lecture par cellule pure (voir `FlowField.sampleDirection`).
    // Ce test verifie la conservation de la vitesse TENUE, pas la geometrie
    // du champ : le centrage evite qu'une composante d'interpolation
    // parasite la sanity check `vyApresRecalcul` ci-dessous.
    horde.x[0] = 2976;
    horde.y[0] = 2976;
    // Vitesse explicitement nulle : sans ca, l'entite garderait la vitesse
    // que `spawn` lui a posee a SA position de formation initiale (tache 20),
    // pas a (2976, 2976), et deriverait avant meme le premier recalcul —
    // inoffensif avec l'ancienne lecture par cellule (uniforme sur toute la
    // cellule), plus depuis l'interpolation.
    horde.vx[0] = 0;
    horde.vy[0] = 0;
    const fields = fieldsTowards(6000, 2976);
    horde.retarget([6000, 6000, 6000, 6000], [2976, 2976, 2976, 2976]);

    const K = STEERING_RECOMPUTE_TICKS;
    const phase = horde.entityIdAt(0) % K;

    // Avance jusqu'au premier recalcul (tick === phase) pour partir d'une
    // vitesse fraichement posee, tournee vers (6000, 2976).
    for (let tick = 0; tick <= phase; tick++) {
      horde.step(DT, fields, tick);
    }
    const vxApresRecalcul = horde.vx[0] ?? 0;
    const vyApresRecalcul = horde.vy[0] ?? 0;
    // Sanity : le recalcul a bien pose une vitesse non nulle, vers l'est.
    expect(vxApresRecalcul).toBeGreaterThan(0);
    expect(vyApresRecalcul).toBeCloseTo(0, 5);

    // Le champ change de direction (vers le nord) APRES ce recalcul : si
    // l'entite recalculait a chaque tick, sa vitesse suivrait immediatement.
    // Si elle la TIENT, comme le veut la tache 19, `vx`/`vy` doivent rester
    // EXACTEMENT ce qu'ils etaient, jusqu'a son prochain tick de phase.
    for (const f of fields) {
      f.update(2976, 0);
    }
    horde.retarget([2976, 2976, 2976, 2976], [0, 0, 0, 0]);

    for (let k = 1; k < K; k++) {
      const tick = phase + k;
      horde.step(DT, fields, tick);
      expect(horde.vx[0]).toBe(vxApresRecalcul);
      expect(horde.vy[0]).toBe(vyApresRecalcul);
    }

    // Et elle avance bien en LIGNE DROITE pendant ce temps : le deplacement
    // cumule sur ces K-1 pas est exactement `vitesse * (K-1) * dt`, a la
    // clampe de bord pres (loin ici de tout bord).
    const attendu = vxApresRecalcul * DT * (K - 1);
    // Precision a 1 decimale : Float32Array accumule une erreur d'arrondi sur
    // K additions successives, sans rapport avec ce que ce test verifie.
    expect(horde.x[0] ?? 0).toBeCloseTo(2976 + vxApresRecalcul * DT + attendu, 1);
  });

  it("la phase de recalcul vient de l'identite : deux entites d ids differents ne recalculent pas au meme tick, et l'identite suit une entite compactee dans un nouveau creneau", () => {
    // Mutation visee : une phase derivee de l'INDICE DE CRENEAU plutot que de
    // l'identite (`entityIdAt`). Les deux coincident a l'apparition — ce test
    // les fait diverger expres par une compaction, pour que la mutation
    // n'ait nulle part ou se cacher.
    const K = STEERING_RECOMPUTE_TICKS;
    const horde = new Horde(20);
    horde.spawn(order({ waveId: 1, count: K + 1, formation: FORMATION.SCATTER }));
    // Toutes au meme endroit, loin de tout bord : seule la phase peut
    // expliquer quand chacune obtient sa premiere vitesse non nulle.
    for (let i = 0; i < horde.count; i++) {
      horde.x[i] = 3000;
      horde.y[i] = 3000;
    }
    const fields = fieldsTowards(6000, 3000);
    horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);

    // L'identite qui va se retrouver au creneau 0 apres compaction : la
    // DERNIERE (index K), jamais l'identite d'origine du creneau 0.
    const survivorId = horde.entityIdAt(K);
    const phaseParIdentite = survivorId % K;
    // Le piege que ce test doit attraper : une implementation qui derive la
    // phase du CRENEAU (0 apres compaction) plutot que de l'identite donnerait
    // 0 % K = 0 — presque toujours different de `phaseParIdentite` ci-dessus.
    const phaseSiParCreneau = 0 % K;
    expect(phaseParIdentite).not.toBe(phaseSiParCreneau);

    // Tue le creneau 0 : la compaction (`Horde.kill`) deplace la derniere
    // entite (celle d'identite `survivorId`) dans le trou.
    horde.kill([horde.entityIdAt(0)]);
    expect(horde.entityIdAt(0)).toBe(survivorId); // sanity : bien compactee au creneau 0

    let firstNonZeroTick = -1;
    for (let tick = 0; tick < 3 * K; tick++) {
      horde.step(DT, fields, tick);
      if (firstNonZeroTick < 0 && ((horde.vx[0] ?? 0) !== 0 || (horde.vy[0] ?? 0) !== 0)) {
        firstNonZeroTick = tick;
      }
    }

    expect(firstNonZeroTick).toBe(phaseParIdentite);
  });

  it('aucun deplacement ne depasse la vitesse propre PLUS la borne de de-chevauchement en un tick, meme entassee (taches 21 et 22)', () => {
    // ⚠️ Le champ doit rester NON NUL ici, contrairement a l'ancien test
    // « plafond de repulsion » (tache 19) qui isolait la repulsion en posant
    // les entites PILE sur leur cible. Depuis la tache 21, la repulsion est
    // ponderee par un poids SANS DIMENSION (`STEERING_REPULSION_WEIGHT = 0,5`,
    // bien plus petit que l'ancienne raideur en px/s) : sur un champ nul, meme
    // une regression qui reintroduirait l'ADDITION (`vx = fx*vitesse +
    // pushX*POIDS`) resterait sous la borne (poids max 0,5 px/s, negligeable
    // devant les ~95 px/s d'une vitesse propre) et ce test ne verrait RIEN.
    // Avec un champ non nul et des voisins places pour pousser dans le MEME
    // sens que lui, la regression additive fait depasser la borne meme avec
    // ce petit poids — voir la mutation en tete de ce fichier de tests.
    //
    // Tache 22 : le meme entassement — deliberement dense, des voisins a 2 px
    // les uns des autres, tous BIEN EN DECA de `SEPARATION_RADIUS` (28 px) —
    // sert AUSSI a saturer `#applyDeoverlap` : la borne totale a verifier
    // n'est donc plus `vitesse_propre * dt` seule, mais CETTE valeur PLUS
    // `DEOVERLAP_MAX_PX`. Sans un entassement aussi serre, la correction de
    // position resterait sous sa propre borne sans jamais l'atteindre, et ce
    // test ne prouverait rien sur elle — d'ou l'exigence de la tache : « a
    // n'importe quelle densite », construit sur un tas deliberement dense.
    const ORIGIN_X = 1000;
    const ORIGIN_Y = 3000;
    const N = 11; // une « victime » plus dix voisins presque colles, tous derriere elle.
    const horde = new Horde(N);
    horde.spawn(order({ count: N, formation: FORMATION.SCATTER }));
    horde.x[0] = ORIGIN_X;
    horde.y[0] = ORIGIN_Y;

    const fields = fieldsTowards(5000, ORIGIN_Y);
    // Direction REELLE du champ a la position de la victime, lue plutot que
    // supposee (1, 0) : seul ce qui compte pour la mutation ci-dessus, c'est
    // que les voisins poussent dans le MEME sens qu'elle, quelle que soit
    // cette direction.
    const field0 = fields[0];
    if (!field0) {
      throw new Error('champ manquant');
    }
    const cell = field0.indexAt(ORIGIN_X, ORIGIN_Y);
    const fx = field0.dirX[cell] ?? 0;
    const fy = field0.dirY[cell] ?? 0;
    expect(Math.hypot(fx, fy)).toBeGreaterThan(0.9); // sanity : champ bien non nul.

    for (let i = 1; i < N; i++) {
      // « Derriere » la victime par rapport au champ : la direction de
      // l'entite vers ce voisin est `-(fx, fy)`, donc la repulsion qu'il lui
      // inflige pointe `+(fx, fy)` — le MEME sens que le champ.
      horde.x[i] = ORIGIN_X - i * 2 * fx;
      horde.y[i] = ORIGIN_Y - i * 2 * fy;
    }
    // Joueurs loin de la victime : contrairement a la cible du champ, un
    // joueur proche la mettrait a portee de contact (tache 17.2) et
    // l'arreterait (`stopped`), ce qui rendrait ce test aveugle a un
    // deplacement pourtant illegal (`#advanceByVelocity` n'avance jamais une
    // entite arretee).
    horde.retarget([0, 0, 0, 0], [0, 0, 0, 0]);

    const ownSpeed = archetypeOf(0).speed;
    // Tache 22 : deplacement max legitime en UN tick = avancement par vitesse
    // (borne intrinseque, tache 21) PLUS correction de de-chevauchement
    // (borne explicite, tache 22) — les deux s'appliquent au MEME tick, dans
    // cet ordre (voir `Horde.step`), et peuvent donc s'additionner.
    const COMBINED_BOUND = ownSpeed * DT + DEOVERLAP_MAX_PX;
    const BOUND = COMBINED_BOUND + 1e-3; // marge flottante minime.
    let maxDisplacement = 0;

    for (let tick = 0; tick < STEERING_RECOMPUTE_TICKS + 2; tick++) {
      const beforeX = horde.x.slice(0, horde.count);
      const beforeY = horde.y.slice(0, horde.count);
      horde.step(DT, fields, tick);
      for (let i = 0; i < horde.count; i++) {
        const d = Math.hypot(
          (horde.x[i] ?? 0) - (beforeX[i] ?? 0),
          (horde.y[i] ?? 0) - (beforeY[i] ?? 0),
        );
        expect(d).toBeLessThanOrEqual(BOUND);
        if (d > maxDisplacement) {
          maxDisplacement = d;
        }
      }
    }

    // Le test ne prouverait rien sur LA SOMME des deux bornes si l'entassement
    // n'avait jamais fait approcher le deplacement observe de leur total —
    // une simple regression qui plafonnerait `#applyDeoverlap` a une valeur
    // trop petite (ou la supprimerait) resterait invisible a un seuil moins
    // exigeant que celui-ci.
    //
    // ⚠️ **Tache 23 : ce n'est plus forcement la « victime » (creneau 0) qui
    // sature.** Sous la priorite, la victime — la plus proche de la cible du
    // champ — ne cede a AUCUN de ses dix voisins (tous plus loin qu'elle) :
    // elle n'est plus corrigee du tout par `#applyDeoverlap`. C'est un AUTRE
    // membre du tas (celui le plus loin derriere, qui cede a la quasi
    // totalite des neuf autres) qui accumule la plus grosse correction et
    // approche la borne — verifie par mesure ad hoc (rapport de la tache 23) :
    // la borne combinee reste atteinte au pixel pres, juste par un creneau
    // different. L'assertion ci-dessus, qui parcourt TOUTES les entites, reste
    // donc valide sans changement.
    expect(maxDisplacement).toBeGreaterThan(COMBINED_BOUND * 0.9);
  });

  it('un monstre pile sur sa cible et entoure symetriquement ne produit jamais de NaN (tache 21 : cas degenere)', () => {
    // Le VRAI cas degenere de la doc de `#recomputeSteering` : la somme
    // « direction du champ + repulsion ponderee » s'annule EXACTEMENT, pas
    // approximativement.
    //
    // ⚠️ **Mecanisme reecrit pour la tache 23.** Avant, la repulsion
    // s'annulait par symetrie vectorielle (quatre voisins cardinaux
    // equidistants, `+a` et `-a` s'annulant deux a deux). Depuis la priorite,
    // la repulsion ne se resume plus par paire symetrique : ici, la victime
    // et ses quatre voisins sont installes dans la MEME cellule de flowfield
    // (`D = 20` px, bien en-deca de la demi-largeur de cellule 32 px) —
    // exactement A EGALITE de `dist`. A egalite, le plus petit identifiant
    // gagne (tache 23) : la victime est l'entite 0, la plus petite identite
    // du groupe, donc elle ne cede JAMAIS a aucun de ses quatre voisins —
    // elle n'accumule RIEN contre eux, quelle que soit leur position. La
    // repulsion est donc nulle par ABSENCE d'accumulation, pas par
    // annulation vectorielle — mais le code exerce, bit pour bit, le MEME
    // garde-fou : la victime est PILE sur sa cible (direction de champ
    // nulle), la repulsion accumulee est nulle, la somme est nulle, et la
    // diviser sans garde-fou donnerait EXACTEMENT `0 / 0 = NaN`.
    //
    // Mutation visee : supprimer le garde-fou du cas degenere et diviser
    // inconditionnellement (voir le rapport de la tache 21, mutation 2 —
    // reproduite a la main pour verifier ce test, ce qu'un simple contexte
    // n'aurait pas suffi a garantir ; revalidee tache 23). Un test qui ne
    // verifierait que la NORME finale ne verrait rien : `Math.hypot(NaN,
    // NaN)` est `NaN`, et `toBeLessThanOrEqual` echoue en silence dessus,
    // alors que `Number.isFinite` le demasque sans ambiguite.
    const ORIGIN_X = 2976; // Centre d'une cellule de flowfield (64 px) : ...
    const ORIGIN_Y = 2976; // ... les 4 voisins a +-D restent dans LA MEME cellule.
    const D = 20; // < demi-largeur de cellule (32) : garantit l'egalite de dist.
    const horde = new Horde(5);
    horde.spawn(order({ count: 5, formation: FORMATION.SCATTER }));
    // La victime, EXACTEMENT sur la cible de son champ...
    horde.x[0] = ORIGIN_X;
    horde.y[0] = ORIGIN_Y;
    // ...entouree aux quatre points cardinaux, dans la MEME cellule.
    horde.x[1] = ORIGIN_X + D;
    horde.y[1] = ORIGIN_Y;
    horde.x[2] = ORIGIN_X - D;
    horde.y[2] = ORIGIN_Y;
    horde.x[3] = ORIGIN_X;
    horde.y[3] = ORIGIN_Y + D;
    horde.x[4] = ORIGIN_X;
    horde.y[4] = ORIGIN_Y - D;

    const fields = fieldsTowards(ORIGIN_X, ORIGIN_Y);
    horde.retarget([0, 0, 0, 0], [0, 0, 0, 0]);

    const field0 = fields[0];
    if (!field0) {
      throw new Error('champ manquant');
    }
    const cell = field0.indexAt(ORIGIN_X, ORIGIN_Y);
    // Sanity : le champ est bien nul exactement la ou on le suppose, sans
    // quoi ce test ne serait pas le cas degenere qu'il pretend etre.
    expect(field0.dirX[cell] ?? -1).toBe(0);
    expect(field0.dirY[cell] ?? -1).toBe(0);
    // Sanity (tache 23) : les cinq points partagent bien la MEME cellule —
    // condition necessaire a l'egalite de `dist` dont ce test depend.
    for (let i = 1; i < horde.count; i++) {
      expect(field0.indexAt(horde.x[i] ?? 0, horde.y[i] ?? 0)).toBe(cell);
    }

    // Phase de recalcul de la victime : les quatre voisins, d'identite
    // superieure, recalculent a une phase LATER dans le cycle (voir plus
    // bas) — la victime recalcule donc seule, avant que quiconque n'ait pu
    // bouger.
    const victimPhase = horde.entityIdAt(0) % STEERING_RECOMPUTE_TICKS;
    for (let i = 1; i < horde.count; i++) {
      expect(horde.entityIdAt(i) % STEERING_RECOMPUTE_TICKS).toBeGreaterThan(victimPhase);
    }

    // Un seul pas, exactement au tick de phase de la victime : suffisant pour
    // exercer le cas degenere une fois, dans la configuration EXACTE decrite
    // ci-dessus, avant que les voisins n'aient eu l'occasion de bouger.
    horde.step(DT, fields, victimPhase);

    for (let i = 0; i < horde.count; i++) {
      // Le coeur de l'assertion : JAMAIS de NaN, pour AUCUNE entite — pas
      // seulement la victime au centre.
      expect(Number.isFinite(horde.vx[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(horde.vy[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(horde.x[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(horde.y[i] ?? NaN)).toBe(true);
    }

    // Le cas degenere retombe sur la direction du champ SEULE — ici nulle —
    // jamais sur un `NaN` : la victime reste immobile, pas indeterminee.
    expect(horde.vx[0]).toBe(0);
    expect(horde.vy[0]).toBe(0);
    expect(horde.x[0]).toBe(ORIGIN_X);
    expect(horde.y[0]).toBe(ORIGIN_Y);
  });

  it('un monstre entoure de voisins dont la repulsion s annule continue de suivre son champ (tache 21)', () => {
    // Complement du test precedent : ici, la victime n'est PAS sur sa cible
    // (champ non nul), et la repulsion accumulee est nulle (pas la somme
    // entiere). Mutation visee : une implementation qui traiterait
    // « repulsion nulle » comme le cas degenere (au lieu de « somme totale
    // nulle ») et retomberait a tort sur une vitesse nulle, alors que la
    // victime devrait continuer de suivre son champ normalement.
    //
    // ⚠️ **Mecanisme reecrit pour la tache 23**, meme raisonnement que le
    // test precedent : victime et voisins dans la MEME cellule de flowfield
    // (egalite exacte de `dist`), victime = identite la plus petite du
    // groupe => elle ne cede a aucun de ses quatre voisins => repulsion
    // accumulee nulle, PAR ABSENCE d'accumulation. La direction du champ,
    // elle, est non nulle (la cible est ailleurs) : la somme MELANGEE reste
    // donc non nulle, et le code doit suivre la branche NORMALE (jamais le
    // garde-fou degenere) pour aboutir exactement a la direction du champ.
    const ORIGIN_X = 2976;
    const ORIGIN_Y = 2976;
    const D = 20;
    const horde = new Horde(5);
    horde.spawn(order({ count: 5, formation: FORMATION.SCATTER }));
    horde.x[0] = ORIGIN_X;
    horde.y[0] = ORIGIN_Y;
    horde.x[1] = ORIGIN_X + D;
    horde.y[1] = ORIGIN_Y;
    horde.x[2] = ORIGIN_X - D;
    horde.y[2] = ORIGIN_Y;
    horde.x[3] = ORIGIN_X;
    horde.y[3] = ORIGIN_Y + D;
    horde.x[4] = ORIGIN_X;
    horde.y[4] = ORIGIN_Y - D;

    // Champ non nul : la cible est ailleurs que la position de la victime.
    const fields = fieldsTowards(5000, ORIGIN_Y);
    horde.retarget([0, 0, 0, 0], [0, 0, 0, 0]);

    const field0 = fields[0];
    if (!field0) {
      throw new Error('champ manquant');
    }
    const cell = field0.indexAt(ORIGIN_X, ORIGIN_Y);
    const fx = field0.dirX[cell] ?? 0;
    const fy = field0.dirY[cell] ?? 0;
    expect(Math.hypot(fx, fy)).toBeGreaterThan(0.9); // sanity : champ bien non nul.
    // Sanity (tache 23) : les cinq points partagent bien la MEME cellule —
    // condition necessaire a l'egalite de `dist` dont ce test depend, MEME
    // quand la cible du champ est ailleurs (`dist` depend de la cellule, pas
    // du point exact).
    for (let i = 1; i < horde.count; i++) {
      expect(field0.indexAt(horde.x[i] ?? 0, horde.y[i] ?? 0)).toBe(cell);
    }

    const victimPhase = horde.entityIdAt(0) % STEERING_RECOMPUTE_TICKS;
    for (let i = 1; i < horde.count; i++) {
      expect(horde.entityIdAt(i) % STEERING_RECOMPUTE_TICKS).toBeGreaterThan(victimPhase);
    }

    horde.step(DT, fields, victimPhase);

    for (let i = 0; i < horde.count; i++) {
      expect(Number.isFinite(horde.vx[i] ?? NaN)).toBe(true);
      expect(Number.isFinite(horde.vy[i] ?? NaN)).toBe(true);
    }

    const ownSpeed = archetypeOf(0).speed;
    // Repulsion nulle => la vitesse tenue est EXACTEMENT la direction du
    // champ mise a l'echelle de la vitesse propre — la victime avance,
    // elle ne se fige pas.
    expect(horde.vx[0] ?? 0).toBeCloseTo(fx * ownSpeed, 5);
    expect(horde.vy[0] ?? 0).toBeCloseTo(fy * ownSpeed, 5);
  });

  it('une entite qui recalcule voit TOUS ses voisins, meme ceux d un indice de creneau INFERIEUR', () => {
    // Mutation visee : la reapparition du parcours symetrique `j > i` de
    // l'ancien `SeparationGrid` (voir sa doc, tache 18) — une optimisation
    // valide seulement quand tout le monde recalcule au meme tick, et que la
    // tache 19 interdit precisement pour cette raison (voir le rapport).
    // Avec `j > i`, l'entite de creneau 0 verrait l'entite de creneau 1 (1 >
    // 0), mais l'entite de creneau 1 ne verrait JAMAIS celle de creneau 0
    // (0 <= 1) : sa vitesse ne porterait alors QUE la direction du champ,
    // jamais la repulsion de sa voisine.
    //
    // Deux entites presque colles, toutes deux posees PILE sur la cible de
    // leur champ (flux nul, meme piege evite que le test precedent) : tout
    // `vx`/`vy` mesure est donc ENTIEREMENT la repulsion.
    //
    // ⚠️ **Depuis la tache 23, la relation n'est plus symetrique.** Les deux
    // entites sont a EGALE distance-cellule de la cible (meme cellule) : a
    // egalite, le plus petit identifiant gagne, donc le creneau 0 (identite
    // la plus petite) ne cede JAMAIS a l'autre — sa vitesse de repulsion doit
    // rester EXACTEMENT nulle, pas seulement non verifiee. Seul le creneau 1
    // (identite la plus grande) cede et porte une repulsion non nulle. Le
    // piege que ce test attrape reste le meme (`j > i` empecherait le creneau
    // de PLUS HAUT indice de voir celui de PLUS BAS indice), mais l'assertion
    // change : ce n'est plus « les deux bougent », c'est « seul celui de
    // derriere bouge, et celui de devant reste a zero au bit pres ».
    // Centre EXACT d'une cellule de flowfield (tache 25) : sur sa propre
    // cible, une entite doit rester direction (0, 0) au bit pres pour que
    // l'assertion `vx[0] === 0` ci-dessous tienne — vrai seulement au centre
    // de cellule depuis l'interpolation bilineaire (voir
    // `FlowField.sampleDirection`), plus sur n'importe quel point de la
    // cellule comme avant cette tache.
    const TARGET_X = 2976;
    const TARGET_Y = 2976;
    const horde = new Horde(2);
    horde.spawn(order({ count: 2, formation: FORMATION.SCATTER }));
    horde.x[0] = TARGET_X;
    horde.y[0] = TARGET_Y;
    horde.x[1] = TARGET_X + 0.001;
    horde.y[1] = TARGET_Y;
    const fields = fieldsTowards(TARGET_X, TARGET_Y);
    horde.retarget(
      [TARGET_X, TARGET_X, TARGET_X, TARGET_X],
      [TARGET_Y, TARGET_Y, TARGET_Y, TARGET_Y],
    );

    // Assez de pas pour que CHAQUE creneau ait recalcule AU MOINS UNE FOIS,
    // pas plus : depuis la tache 22, `Horde.step` ecarte aussi les deux
    // entites d'une correction de position bornee (`#applyDeoverlap`, EN
    // PLUS de la repulsion de pilotage mesuree ici) — courir jusqu'a
    // `2 * STEERING_RECOMPUTE_TICKS` comme avant les laisserait largement
    // depasser `SEPARATION_RADIUS`, la repulsion s'annulerait ALORS
    // legitimement (elles ne sont plus voisines), et le test ne mesurerait
    // plus la meme chose. On s'arrete donc au premier recalcul de CHAQUE
    // creneau.
    const phase0 = horde.entityIdAt(0) % STEERING_RECOMPUTE_TICKS;
    const phase1 = horde.entityIdAt(1) % STEERING_RECOMPUTE_TICKS;
    for (let tick = 0; tick <= Math.max(phase0, phase1); tick++) {
      horde.step(DT, fields, tick);
    }

    // Le creneau DE PLUS HAUT INDICE (1, identite la plus grande) doit porter
    // une vitesse de repulsion non nulle — c'est precisement ce que `j > i`
    // lui interdirait, et ce que la priorite (tache 23) lui impose puisqu'il
    // cede a egalite de distance.
    expect(Math.hypot(horde.vx[1] ?? 0, horde.vy[1] ?? 0)).toBeGreaterThan(0);
    // Le creneau 0 (identite la plus petite) ne cede JAMAIS a egalite : sa
    // vitesse de repulsion doit rester EXACTEMENT nulle, au bit pres — pas
    // seulement « non testee ».
    expect(horde.vx[0]).toBe(0);
    expect(horde.vy[0]).toBe(0);
  });

  it('deux clients simules independamment s accordent tick pour tick, y compris a travers un rejeu (rollback)', () => {
    // Le point precis que ce test cherche a attraper : une vitesse tenue
    // (`vx`/`vy`) qui serait SAUVEGARDEE mais pas RESTAUREE (ou l'inverse) —
    // exactement le defaut qu'une regression sur `HordeState`/`saveState`/
    // `restoreState` introduirait sans faire rougir aucun autre test de ce
    // fichier. Deux hordes independantes, une mort livree en RETARD a la
    // seconde (latence reseau simulee), rejouee via restauration + rejeu —
    // le meme montage que le scenario 9 de `horde.replication.test.ts`, en
    // miniature et cible sur `vx`/`vy` specifiquement.
    const fields = fieldsTowards(6000, 3000);
    const stepsPerField = 3;

    function makeParticipant(): { horde: Horde; history: HordeHistoryLike } {
      const horde = new Horde(50);
      horde.spawn(
        order({ waveId: 9, count: 20, formation: FORMATION.CLUSTER, anchorX: 3000, anchorY: 3000 }),
      );
      horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
      return { horde, history: new HordeHistoryLike(horde.capacity) };
    }

    // ⚠️ **`HordeState` importe, jamais recopie ici.** Une copie locale de la
    // forme etait une TROISIEME liste de tableaux a tenir a jour (avec
    // `#removeAt` et `HordeHistory`), et c'est exactement la classe de defaut
    // que ce depot paie le plus cher : elle vieillit en silence. Ajouter un
    // tableau a `Horde` casse desormais la compilation ici, au lieu de laisser
    // ce rejeu miniature travailler sur un instantane incomplet.
    class HordeHistoryLike {
      readonly #states = new Map<number, HordeState>();
      constructor(private readonly capacity: number) {}
      record(tick: number, horde: Horde): void {
        const state: HordeState = {
          count: 0,
          x: new Float32Array(this.capacity),
          y: new Float32Array(this.capacity),
          vx: new Float32Array(this.capacity),
          vy: new Float32Array(this.capacity),
          archetype: new Uint8Array(this.capacity),
          waveId: new Uint16Array(this.capacity),
          indexInWave: new Uint16Array(this.capacity),
          animPhase: new Uint8Array(this.capacity),
          targetField: new Uint8Array(this.capacity),
          stopped: new Uint8Array(this.capacity),
          hp: new Float32Array(this.capacity),
          mark: new Uint8Array(this.capacity),
          markBy: new Uint8Array(this.capacity),
          markUntil: new Float64Array(this.capacity),
        };
        horde.saveState(state);
        this.#states.set(tick, state);
      }
      restore(tick: number, horde: Horde): boolean {
        const state = this.#states.get(tick);
        if (!state) {
          return false;
        }
        horde.restoreState(state);
        return true;
      }
    }

    const a = makeParticipant(); // « le serveur » : applique la mort a l'instant.
    const b = makeParticipant(); // « le client » : l'apprend 4 ticks plus tard, rejoue.

    const DEATH_TICK = 20;
    const DEATH_DELAY = 4;
    const deathId = a.horde.entityIdAt(0);
    const END = 60;

    for (let tick = 0; tick < END; tick++) {
      for (const p of [a, b]) {
        if (tick % stepsPerField === 0) {
          p.horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
        }
        p.horde.step(DT, fields, tick);
      }
      a.history.record(tick, a.horde);
      b.history.record(tick, b.horde);

      if (tick === DEATH_TICK) {
        a.horde.kill([deathId]);
      }
      if (tick === DEATH_TICK + DEATH_DELAY) {
        // `b` apprend la mort en retard : restaure au tick de la mort,
        // l'applique, rejoue jusqu'au present — exactement `applyDeathWithReplay`
        // de `horde.replication.test.ts`, en miniature.
        const restored = b.history.restore(DEATH_TICK, b.horde);
        expect(restored).toBe(true);
        b.horde.kill([deathId]);
        for (let t = DEATH_TICK + 1; t <= tick; t++) {
          if (t % stepsPerField === 0) {
            b.horde.retarget([6000, 6000, 6000, 6000], [3000, 3000, 3000, 3000]);
          }
          b.horde.step(DT, fields, t);
        }
      }
    }

    expect(a.horde.count).toBe(b.horde.count);
    for (let i = 0; i < a.horde.count; i++) {
      expect(a.horde.entityIdAt(i)).toBe(b.horde.entityIdAt(i));
      // Le coeur du test : position ET vitesse tenue identiques, au bit pres.
      // Une vitesse restauree a zero (ou pas restauree du tout) ferait
      // diverger `x`/`y` au(x) pas suivant(s) — mais `vx`/`vy` eux-memes
      // divergeraient DEJA ici, avant meme que ca ne se voie sur la position.
      expect(b.horde.vx[i]).toBe(a.horde.vx[i]);
      expect(b.horde.vy[i]).toBe(a.horde.vy[i]);
      expect(b.horde.x[i]).toBe(a.horde.x[i]);
      expect(b.horde.y[i]).toBe(a.horde.y[i]);
    }
  });
});

describe('tache 20 : un seul modele de mouvement pour le rattrapage', () => {
  it('spawn pose une vitesse non nulle des l apparition, sans attendre le premier recalcul de phase', () => {
    // Mutation visee : revenir a `vx = vy = 0` inconditionnel dans `spawn`
    // (le comportement d'avant la tache 20) — une entite fraichement
    // apparue resterait figee jusqu'a `STEERING_RECOMPUTE_TICKS - 1` pas
    // (300 ms), un defaut visible a l'ecran. Verifie AVANT tout appel a
    // `step` : seule `spawn` elle-meme a pu poser cette vitesse.
    const fields = fieldsTowards(4000, 1000);
    const field = fields[0];
    if (!field) {
      throw new Error('champ manquant');
    }

    const horde = new Horde(10);
    // Ancre loin de la cible et de tout bord : le champ y porte a coup sur
    // une direction non nulle (pas d'obstacle ici, donc pas de cellule
    // inatteignable).
    horde.spawn(
      order({ count: 5, anchorX: 1000, anchorY: 1000, formation: FORMATION.SCATTER }),
      field,
    );

    for (let i = 0; i < horde.count; i++) {
      expect(Math.hypot(horde.vx[i] ?? 0, horde.vy[i] ?? 0)).toBeGreaterThan(0);
    }
  });

  it('sans champ fourni, spawn garde le comportement d avant : vitesse nulle', () => {
    // Sanity inverse du test precedent : la nouvelle branche de `spawn` ne
    // doit s'activer que si un champ est passe, pas devenir le nouveau
    // comportement par defaut partout (la plupart des tests de ce fichier
    // spawnent sans champ et n'ont rien a voir avec ce mecanisme).
    const horde = new Horde(10);
    horde.spawn(order({ count: 5, formation: FORMATION.SCATTER }));

    for (let i = 0; i < horde.count; i++) {
      expect(horde.vx[i]).toBe(0);
      expect(horde.vy[i]).toBe(0);
    }
  });

  it('une entite fraichement apparue avance des le tick suivant, sans attendre sa phase', () => {
    // Mutation visee : la meme que le test precedent, mais observee par le
    // mouvement plutot que par la vitesse brute — c'est le symptome que le
    // corollaire du brief decrit (« ca se voit a l'ecran »). Le tick choisi
    // ne correspond PAS a la phase de recalcul de l'entite : si elle bouge
    // quand meme, ce ne peut etre que la vitesse posee par `spawn`, jamais
    // un recalcul de `#recomputeSteering`.
    const K = STEERING_RECOMPUTE_TICKS;
    const fields = fieldsTowards(4000, 1000);
    const field = fields[0];
    if (!field) {
      throw new Error('champ manquant');
    }

    const horde = new Horde(10);
    horde.spawn(
      order({ waveId: 1, count: 1, anchorX: 1000, anchorY: 1000, formation: FORMATION.SCATTER }),
      field,
    );
    const phase = horde.entityIdAt(0) % K;
    const tick = phase === 0 ? 1 : 0;
    expect(tick % K).not.toBe(phase);

    const beforeX = horde.x[0] ?? 0;
    const beforeY = horde.y[0] ?? 0;
    horde.step(DT, fields, tick);

    expect(Math.hypot((horde.x[0] ?? 0) - beforeX, (horde.y[0] ?? 0) - beforeY)).toBeGreaterThan(0);
  });

  it(
    'un rattrapage tardif finit EXACTEMENT comme une apparition a l heure : position ET ' +
      'vitesse, tick par tick, sur plusieurs cycles de phase',
    () => {
      // Mutation visee : reintroduire `#advanceAlongField` (l'ancienne
      // physique du rattrapage, le long du champ) dans la boucle de
      // `spawnCatchingUp`, a la place de `#recomputeSteering` +
      // `#advanceByVelocity`. Les deux hordes ci-dessous partagent le meme
      // champ, la meme cible, le meme ordre de vague — la SEULE difference
      // est que l'une apparait a l'heure et l'autre rattrape `DELAY` pas.
      // Sous un seul modele de mouvement, elles doivent coincider AU BIT
      // PRES des que le rattrapage a rejoue les pas manques — pas seulement
      // au tick ou elles se rejoignent, mais a chaque tick ensuite, a
      // travers plusieurs cycles complets de `STEERING_RECOMPUTE_TICKS`.
      const K = STEERING_RECOMPUTE_TICKS;
      const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
      const SPAWN_TICK = 10;
      const DELAY = 2;
      const END = SPAWN_TICK + 5 * K;

      const wave: WaveOrder = {
        waveId: 1,
        spawnTick: SPAWN_TICK,
        seed: 0x51ee_d001,
        archetype: 0,
        formation: FORMATION.CLUSTER,
        anchorX: 3000,
        anchorY: 3000,
        count: 40,
      };

      const onTimeFields = fieldsTowards(3000, 3000);
      const lateFields = fieldsTowards(3000, 3000);
      const onTime = new Horde(200);
      const late = new Horde(200);

      for (let tick = 0; tick < END; tick++) {
        // Cible mobile : un champ fige ne prouverait rien (voir le reste de
        // ce fichier). Les deux cotes voient EXACTEMENT la meme cible au
        // meme tick — seule la latence d'APPARITION est sous test ici.
        const tx = 4500 + Math.cos(tick * 0.05) * 800;
        const ty = 1500 + Math.sin(tick * 0.05) * 800;

        // Rattrapage EN TETE de tick, avant tout rafraichissement — l'ordre
        // que documente `spawnCatchingUp`.
        if (tick === SPAWN_TICK + DELAY) {
          late.spawnCatchingUp(wave, DELAY, DT, lateFields);
        }

        if (tick % stepsPerField === 0) {
          for (const f of onTimeFields) {
            f.update(tx, ty);
          }
          for (const f of lateFields) {
            f.update(tx, ty);
          }
          onTime.retarget([tx, tx, tx, tx], [ty, ty, ty, ty]);
          late.retarget([tx, tx, tx, tx], [ty, ty, ty, ty]);
        }

        if (tick === SPAWN_TICK) {
          onTime.spawn(wave, onTimeFields[0]);
        }

        onTime.step(DT, onTimeFields, tick);
        late.step(DT, lateFields, tick);

        if (tick >= SPAWN_TICK + DELAY) {
          expect(late.count).toBe(onTime.count);
          for (let i = 0; i < onTime.count; i++) {
            expect(late.x[i]).toBe(onTime.x[i]);
            expect(late.y[i]).toBe(onTime.y[i]);
            expect(late.vx[i]).toBe(onTime.vx[i]);
            expect(late.vy[i]).toBe(onTime.vy[i]);
          }
        }
      }

      // Le test ne prouverait rien si la horde n'avait jamais bouge.
      expect(meanDistanceTo(onTime, 3000, 3000)).toBeGreaterThan(0);
    },
  );
});

describe('tache 22/23 : la horde forme un anneau plutot que de s empiler', () => {
  it(
    'une horde lachee sur un joueur immobile s etale en anneau : bien moins ' +
      'que les 462 entites empilees sans correction, et la horde a reellement converge',
    () => {
      // Mutation visee : supprimer `#applyDeoverlap` (ou vider sa borne a
      // zero) laisse le pilotage seul faire converger la horde vers un TAS —
      // mesure : 462 entites sur 800 a moins de `CONTACT_RADIUS` les unes des
      // autres, sur 8 px² chacune (rapport de la tache 22). Un test qui ne
      // verifierait QUE ce compte serait aveugle a une regression OPPOSEE :
      // `STEERING_REPULSION_WEIGHT` remis a 4 ferait STAGNER la horde loin du
      // joueur (rayon median mesure a 209 px, elle n'arrive jamais) — ce qui
      // produit AUSSI un compte faible dans le rayon de contact, pour une
      // raison inverse. D'ou la seconde assertion : le rayon median doit
      // rester petit, preuve que la horde est bien ARRIVEE et pas seulement
      // dispersee au loin.
      //
      // ⚠️ **Duree portee a 1500 pas (tache 23), pas 300.** Avec l'evitement
      // par priorite, chaque paire n'est plus corrigee que par CELUI de
      // derriere (l'autre n'accumule rien) : la horde converge vers le MEME
      // anneau, mais plus lentement — mesure ad hoc (script hors depot) :
      // rayon median 209 px a 10 s (300 pas, identique au chiffre de
      // stagnation de l'ANCIEN poids 4, par pure coincidence de calendrier,
      // pas parce qu'elle stagne : la mesure continue de baisser), 157 px a
      // 30 s, puis un plateau stable a 148-158 px a partir de 35-40 s (1000+
      // pas) jusqu'a 3600 pas (2 min), jamais en dessous. Mesurer a 10 s
      // confondrait donc a tort une convergence reelle mais lente avec une
      // stagnation — d'ou la duree portee a 1500 pas (50 s), largement dans
      // le plateau. Voir le rapport de la tache 23 pour la mesure complete et
      // la verification par mutation (poids remis a 4 : le median reste
      // alors bloque a 226-237 px meme a 2 min, jamais sous 200).
      const N = 800;
      const PLAYER_X = 3000;
      const PLAYER_Y = 3000;
      const TOTAL_TICKS = 1500; // 50 s a TICK_HZ = 30 : voir la note ci-dessus.
      // Valeurs mesurees dans le rapport de la tache 22 (repulsion seule,
      // sans correction de position) : le point de comparaison, pas une
      // borne que ce test cherche a reproduire au pixel pres.
      const STACKED_COUNT_WITHOUT_CORRECTION = 462;
      // Rayon en-deca duquel la horde est reputee ARRIVEE (tache 23) : marge
      // confortable sous le plateau mesure (148-158 px) et tres en-deca du
      // point de stagnation d'une repulsion qui dominerait le champ (226-237
      // px, verifie par mutation — voir la note ci-dessus).
      const ARRIVED_RADIUS = 200;

      const horde = new Horde(N);
      const fields = fieldsTowards(PLAYER_X, PLAYER_Y);
      horde.spawn(
        order({ count: N, formation: FORMATION.SCATTER, anchorX: PLAYER_X, anchorY: PLAYER_Y }),
        fields[0],
      );

      const history = new PlayerHistory();
      const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
      const px = [PLAYER_X, PLAYER_X, PLAYER_X, PLAYER_X];
      const py = [PLAYER_Y, PLAYER_Y, PLAYER_Y, PLAYER_Y];

      for (let tick = 0; tick < TOTAL_TICKS; tick++) {
        history.record(tick, px, py);
        if (tick % stepsPerField === 0) {
          const seen = history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            horde.retarget(seen.x, seen.y);
          }
        }
        horde.step(DT, fields, tick);
      }

      const radii: number[] = [];
      let insideContact = 0;
      for (let i = 0; i < horde.count; i++) {
        const r = Math.hypot((horde.x[i] ?? 0) - PLAYER_X, (horde.y[i] ?? 0) - PLAYER_Y);
        radii.push(r);
        if (r <= CONTACT_RADIUS) {
          insideContact++;
        }
      }
      radii.sort((a, b) => a - b);
      const median = radii[Math.floor(radii.length / 2)] ?? 0;

      process.stdout.write(
        `anneau (tache 22) : ${insideContact}/${N} a moins de ${CONTACT_RADIUS} px, ` +
          `rayon median ${median.toFixed(1)} px\n`,
      );

      // Bien moins que le tas mesure sans correction de position — la moitie
      // suffit a distinguer un anneau d'un tas, sans etre fragile au bruit
      // d'un tirage particulier.
      expect(insideContact).toBeLessThan(STACKED_COUNT_WITHOUT_CORRECTION / 2);
      // Et la horde a REELLEMENT converge, pas seulement dispersee au loin —
      // voir la note sur `ARRIVED_RADIUS` ci-dessus pour la mesure qui motive
      // ce seuil et la mutation qui le justifie.
      expect(median).toBeLessThan(ARRIVED_RADIUS);
    },
  );
});

describe('tache 23 : evitement par priorite, celui de derriere cede', () => {
  it(
    'deux entites qui se chevauchent : seule celle de derriere bouge, celle de ' +
      'devant ne bouge pas d un seul pixel',
    () => {
      // Mutation visee : reintroduire la moitie chacun (`* 0.5`) dans
      // `#applyDeoverlap` au lieu du filtre de priorite — l'ancien
      // comportement symetrique de la tache 22, ou LES DEUX membres d'une
      // paire en chevauchement bougent. Verifiee plus bas.
      //
      // Deux entites a des distances DIFFERENTES (pas une egalite) du champ
      // qu'elles visent : `FRONT` tombe dans une cellule de flowfield plus
      // proche de la cible que `BEHIND` (64 px de cote, la frontiere de
      // cellule tombe entre les deux), tout en restant a 15 px l'une de
      // l'autre — bien EN DECA de `SEPARATION_RADIUS` (chevauchement reel).
      // `FRONT` est donc strictement DEVANT `BEHIND` au sens de la priorite
      // (tache 23) : c'est `BEHIND` qui doit ceder.
      const FRONT_X = 3010; // cellule 47 : plus proche de la cible (5000, *).
      const FRONT_Y = 3000;
      const BEHIND_X = 2995; // cellule 46 : plus loin de la cible.
      const BEHIND_Y = 3000;
      // Sanity geometrique, verifiee ci-dessous par assertion : les deux
      // positions sont bien a moins de `SEPARATION_RADIUS` l'une de l'autre.
      expect(Math.hypot(FRONT_X - BEHIND_X, FRONT_Y - BEHIND_Y)).toBeLessThan(SEPARATION_RADIUS);

      const horde = new Horde(2);
      horde.spawn(order({ count: 2, formation: FORMATION.SCATTER })); // sans champ : vx = vy = 0.
      horde.x[0] = FRONT_X;
      horde.y[0] = FRONT_Y;
      horde.x[1] = BEHIND_X;
      horde.y[1] = BEHIND_Y;

      const fields = fieldsTowards(5000, 3000);
      // Joueurs loin : aucune des deux entites ne s'arrete au contact.
      horde.retarget([100_000, 100_000, 100_000, 100_000], [100_000, 100_000, 100_000, 100_000]);

      const field0 = fields[0];
      if (!field0) {
        throw new Error('champ manquant');
      }
      // Sanity : les deux entites tombent bien dans des cellules DIFFERENTES,
      // et `FRONT` est bien la plus proche de la cible — sans quoi ce test ne
      // serait pas le cas non-egalitaire qu'il pretend etre.
      const cellFront = field0.indexAt(FRONT_X, FRONT_Y);
      const cellBehind = field0.indexAt(BEHIND_X, BEHIND_Y);
      expect(cellFront).not.toBe(cellBehind);
      expect(field0.dist[cellFront] ?? -1).toBeLessThan(field0.dist[cellBehind] ?? -1);

      // Tick 0 : ni l'identite 4096 (`FRONT`, phase 1) ni 4097 (`BEHIND`,
      // phase 2) ne recalculent leur trajectoire ce tick-la (`entityIdOf`
      // pour un seul wave, indices 0 et 1) — tout mouvement observe vient
      // donc UNIQUEMENT de `#applyDeoverlap`, jamais de la vitesse.
      expect(horde.entityIdAt(0) % STEERING_RECOMPUTE_TICKS).not.toBe(0);
      expect(horde.entityIdAt(1) % STEERING_RECOMPUTE_TICKS).not.toBe(0);

      horde.step(1 / TICK_HZ, fields, 0);

      // Le coeur de l'assertion : `FRONT` ne bouge pas d'un SEUL pixel — exact,
      // pas approximatif.
      expect(horde.x[0]).toBe(FRONT_X);
      expect(horde.y[0]).toBe(FRONT_Y);
      expect(horde.vx[0]).toBe(0);
      expect(horde.vy[0]).toBe(0);
      // `BEHIND`, lui, cede : il s'est ecarte de `FRONT`, borne par
      // `DEOVERLAP_MAX_PX` (le chevauchement, 13 px, depasse largement la
      // borne de 4 px par tick).
      expect(horde.x[1]).not.toBe(BEHIND_X);
      const moved = Math.hypot((horde.x[1] ?? 0) - BEHIND_X, (horde.y[1] ?? 0) - BEHIND_Y);
      expect(moved).toBeCloseTo(DEOVERLAP_MAX_PX, 5);
      // Et il s'est ecarte dans le bon sens : plus LOIN de `FRONT`, pas plus pres.
      expect(horde.x[1] ?? 0).toBeLessThan(BEHIND_X);
    },
  );

  it(
    'la distance au champ decide, l identite ne depart age qu a egalite : ' +
      'une identite plus grande devant ne cede pas a une plus petite derriere',
    () => {
      // Mutation visee : un cache de priorite jamais rafraichi (ou toujours a
      // zero) — `#buildPriorityCache` non appele, ou appele une seule fois a
      // la construction plutot qu'a chaque tick. Toutes les distances
      // paraitraient alors EGALES (0), et le departage retomberait
      // systematiquement sur l'identite SEULE, jamais sur la distance
      // reelle. Ce defaut serait invisible au test precedent : `FRONT` y a
      // deja la plus PETITE identite, donc `FRONT` gagnerait de toute facon,
      // que ce soit par sa distance ou par coincidence d'identite. Ici,
      // `FRONT` recoit deliberement l'identite la plus GRANDE des deux : si
      // la distance ne comptait pas, le departage par identite ferait CEDER
      // `FRONT`, l'exact inverse de ce que ce test attend.
      const FRONT_X = 3010; // cellule 47 : plus proche de la cible.
      const FRONT_Y = 3000;
      const BEHIND_X = 2995; // cellule 46 : plus loin.
      const BEHIND_Y = 3000;

      const horde = new Horde(2);
      // `FRONT` recoit le wave le plus GRAND (identite plus grande) ; `BEHIND`
      // le plus petit — le contraire de ce qu'un departage par identite
      // seule choisirait.
      horde.spawn(order({ waveId: 5, count: 1, formation: FORMATION.SCATTER }));
      horde.spawn(order({ waveId: 1, count: 1, formation: FORMATION.SCATTER }));
      horde.x[0] = FRONT_X;
      horde.y[0] = FRONT_Y;
      horde.x[1] = BEHIND_X;
      horde.y[1] = BEHIND_Y;

      const fields = fieldsTowards(5000, 3000);
      horde.retarget([100_000, 100_000, 100_000, 100_000], [100_000, 100_000, 100_000, 100_000]);

      const field0 = fields[0];
      if (!field0) {
        throw new Error('champ manquant');
      }
      // Sanity : `FRONT` porte bien l'identite la plus GRANDE, et est bien
      // la plus proche de la cible (distance-cellule la plus petite) — les
      // deux conditions qui rendent ce test capable de distinguer priorite
      // par distance et departage par identite.
      expect(horde.entityIdAt(0)).toBeGreaterThan(horde.entityIdAt(1));
      const cellFront = field0.indexAt(FRONT_X, FRONT_Y);
      const cellBehind = field0.indexAt(BEHIND_X, BEHIND_Y);
      expect(field0.dist[cellFront] ?? -1).toBeLessThan(field0.dist[cellBehind] ?? -1);
      // Ni l'une ni l'autre ne recalcule sa trajectoire au tick 0 : tout
      // mouvement observe vient uniquement de `#applyDeoverlap`.
      expect(horde.entityIdAt(0) % STEERING_RECOMPUTE_TICKS).not.toBe(0);
      expect(horde.entityIdAt(1) % STEERING_RECOMPUTE_TICKS).not.toBe(0);

      horde.step(1 / TICK_HZ, fields, 0);

      // `FRONT` reste immobile MALGRE son identite plus grande : la distance
      // l'a emporte.
      expect(horde.x[0]).toBe(FRONT_X);
      expect(horde.y[0]).toBe(FRONT_Y);
      // `BEHIND` cede MALGRE son identite plus petite.
      expect(horde.x[1]).not.toBe(BEHIND_X);
      expect(horde.x[1] ?? 0).toBeLessThan(BEHIND_X);
    },
  );

  it(
    'a egalite de distance au champ, le departage par identite tient quel que ' +
      'soit l ordre de construction des deux hordes',
    () => {
      // Mutation visee : un departage qui, au lieu du plus petit identifiant,
      // s'appuierait sur l'ordre du tableau (indice de creneau) — invisible
      // tant qu'on ne construit la MEME paire d'identites dans les DEUX ordres
      // de creneau possibles, comme `shared/separation.test.ts` le faisait
      // pour la separation symetrique (tache 18).
      //
      // Deux entites A ET B, memes deux identites dans les deux hordes
      // (`SMALL_WAVE` < `BIG_WAVE`, donc identite(SMALL_WAVE) <
      // identite(BIG_WAVE)), mais spawnees dans un ordre OPPOSE d'une horde a
      // l'autre — donc a des creneaux (indices de tableau) opposes.
      const SMALL_WAVE = 1;
      const BIG_WAVE = 2;
      const TARGET_X = 3000;
      const TARGET_Y = 3000;
      // A EGALITE exacte de distance-cellule : les deux positions tombent
      // dans la MEME cellule de flowfield (64 px de cote), bien EN DECA de
      // `SEPARATION_RADIUS` l'une de l'autre (chevauchement reel).
      const POS_A = { x: TARGET_X, y: TARGET_Y };
      const POS_B = { x: TARGET_X + 0.5, y: TARGET_Y };

      function build(firstWave: number, secondWave: number): Horde {
        const horde = new Horde(2);
        // L'ORDRE D'APPEL varie ; les identites resultantes (`firstWave` /
        // `secondWave`), elles, ne dependent QUE du waveId, pas du creneau.
        horde.spawn(order({ waveId: firstWave, count: 1, formation: FORMATION.SCATTER }));
        horde.spawn(order({ waveId: secondWave, count: 1, formation: FORMATION.SCATTER }));
        return horde;
      }

      // Horde a : creneau 0 = petite identite, creneau 1 = grande identite.
      const a = build(SMALL_WAVE, BIG_WAVE);
      a.x[0] = POS_A.x;
      a.y[0] = POS_A.y;
      a.x[1] = POS_B.x;
      a.y[1] = POS_B.y;

      // Horde b : ORDRE INVERSE — creneau 0 = grande identite, creneau 1 =
      // petite identite. Memes deux identites, memes deux positions, juste
      // echangees de creneau.
      const b = build(BIG_WAVE, SMALL_WAVE);
      b.x[0] = POS_B.x;
      b.y[0] = POS_B.y;
      b.x[1] = POS_A.x;
      b.y[1] = POS_A.y;

      const smallId = entityIdOf(SMALL_WAVE, 0);
      const bigId = entityIdOf(BIG_WAVE, 0);
      // Sanity : la petite identite occupe bien des creneaux OPPOSES dans les
      // deux hordes — sans quoi ce test ne construirait pas l'ordre inverse
      // qu'il pretend construire.
      expect(a.entityIdAt(0)).toBe(smallId);
      expect(b.entityIdAt(1)).toBe(smallId);
      expect(a.entityIdAt(1)).toBe(bigId);
      expect(b.entityIdAt(0)).toBe(bigId);

      const fieldsA = fieldsTowards(TARGET_X, TARGET_Y);
      const fieldsB = fieldsTowards(TARGET_X, TARGET_Y);
      const far = [100_000, 100_000, 100_000, 100_000];
      a.retarget(far, far);
      b.retarget(far, far);

      // Tick 0 : ni l'une ni l'autre des deux identites ne recalcule sa
      // trajectoire (`entityIdOf(SMALL_WAVE, 0) % K` et
      // `entityIdOf(BIG_WAVE, 0) % K` different tous deux de 0 — verifie ici
      // plutot que suppose, puisque `SMALL_WAVE`/`BIG_WAVE` sont arbitraires).
      const K = STEERING_RECOMPUTE_TICKS;
      expect(smallId % K).not.toBe(0);
      expect(bigId % K).not.toBe(0);

      a.step(1 / TICK_HZ, fieldsA, 0);
      b.step(1 / TICK_HZ, fieldsB, 0);

      const slotOfSmallInA = a.slotOf(smallId);
      const slotOfBigInA = a.slotOf(bigId);
      const slotOfSmallInB = b.slotOf(smallId);
      const slotOfBigInB = b.slotOf(bigId);

      // Le coeur du test : la PETITE identite ne bouge JAMAIS, quel que soit
      // le creneau qu'elle occupe.
      expect(a.x[slotOfSmallInA]).toBe(POS_A.x);
      expect(a.y[slotOfSmallInA]).toBe(POS_A.y);
      expect(b.x[slotOfSmallInB]).toBe(POS_A.x);
      expect(b.y[slotOfSmallInB]).toBe(POS_A.y);

      // La GRANDE identite, elle, cede TOUJOURS — de la MEME distance, dans
      // les deux hordes.
      expect(a.x[slotOfBigInA]).not.toBe(POS_B.x);
      expect(b.x[slotOfBigInB]).not.toBe(POS_B.x);
      const movedInA = Math.hypot(
        (a.x[slotOfBigInA] ?? 0) - POS_B.x,
        (a.y[slotOfBigInA] ?? 0) - POS_B.y,
      );
      const movedInB = Math.hypot(
        (b.x[slotOfBigInB] ?? 0) - POS_B.x,
        (b.y[slotOfBigInB] ?? 0) - POS_B.y,
      );
      expect(movedInA).toBeCloseTo(movedInB, 5);
      expect(movedInA).toBeGreaterThan(0);
    },
  );

  // Le troisieme test demande par le brief — « le deplacement total reste
  // borne par la vitesse propre plus la correction, a n'importe quelle
  // densite » — est deja couvert par le test existant (taches 21/22)
  // « aucun deplacement ne depasse la vitesse propre PLUS la borne de
  // de-chevauchement en un tick, meme entassee », plus haut dans ce fichier :
  // sa fixture (une victime plus dix voisins presque colles) reste une pile
  // dense sous la priorite, et j'ai verifie (voir son commentaire tache 23,
  // et le rapport de la tache 23) que la saturation du plafond combine reste
  // observee — juste par un creneau different de la pile, puisque la
  // « victime » elle-meme, la plus proche de la cible, ne cede plus a aucun
  // de ses dix voisins. Ecrire un second test redondant sur la meme
  // proposition n'aurait rien ajoute.
});

describe('tache 25 : la horde lit le champ par interpolation, pas par cellule', () => {
  it('la trajectoire tenue reflete le melange bilineaire, pas la lecture par cellule seule', () => {
    // Mutation visee : EXACTEMENT celle deja arrivee sur ce plan (rapport de
    // la tache 25) — un ajout qui fonctionne isole (`FlowField.sampleDirection`,
    // couvert par `shared/flowfield.test.ts`) mais dont l'appelant, ici
    // `Horde`, n'a jamais ete branche dessus et continue de lire `dirX`/`dirY`
    // par cellule. Un test qui ne verifie QUE `FlowField` ne verrait jamais
    // cette regression : il faut verifier `Horde` elle-meme.
    //
    // Deux cellules voisines a angle droit (est vs nord), memes valeurs que
    // le test equivalent de `shared/flowfield.test.ts` — loin de l'oppose
    // exact (180°), ou l'interpolation redevient legitimement instable au
    // point de melange 50/50 (voir sa doc).
    const field = new FlowField(400, 100);
    const cellEast = field.indexAt(150, 150); // cellule (1, 1), centre (150, 150)
    const cellNorth = field.indexAt(250, 150); // cellule (2, 1), centre (250, 150)
    field.dirX[cellEast] = 1;
    field.dirY[cellEast] = 0;
    field.dirX[cellNorth] = 0;
    field.dirY[cellNorth] = 1;
    const fields = [field, field, field, field];

    const horde = new Horde(4);
    horde.spawn(order({ count: 1, formation: FORMATION.SCATTER }));
    // Position PAS au centre d'une cellule, 1 px avant la frontiere (x =
    // 200) : la lecture par cellule et le melange bilineaire divergent ici,
    // c'est le point de tout ce test.
    horde.x[0] = 199.5;
    horde.y[0] = 150;
    horde.vx[0] = 0;
    horde.vy[0] = 0;
    // Cible loin de l'entite : aucun risque d'etre arrete par contact.
    horde.retarget([5000, 5000, 5000, 5000], [5000, 5000, 5000, 5000]);

    const K = STEERING_RECOMPUTE_TICKS;
    const phase = horde.entityIdAt(0) % K;
    for (let tick = 0; tick <= phase; tick++) {
      horde.step(DT, fields, tick);
    }

    const speed = archetypeOf(0).speed;
    // Melange bilineaire ATTENDU a (199.5, 150) : tx = 0.495, ty = 0 (meme
    // ligne que les deux cellules) — calcule ici avec la MEME formule que
    // `FlowField.sampleDirection`, pas copie de sa sortie, pour que ce test
    // reste un test de branchement et non une redite du test de la formule.
    const tx = 199.5 / 100 - 0.5 - Math.floor(199.5 / 100 - 0.5);
    const blendX = (1 - tx) * 1 + tx * 0;
    const blendY = (1 - tx) * 0 + tx * 1;
    const mag = Math.hypot(blendX, blendY);
    const expectedVx = (blendX / mag) * speed;
    const expectedVy = (blendY / mag) * speed;

    expect(horde.vx[0] ?? 0).toBeCloseTo(expectedVx, 3);
    expect(horde.vy[0] ?? 0).toBeCloseTo(expectedVy, 3);

    // Sanity : la lecture par cellule seule donnerait plein est, `vy = 0`,
    // visiblement different de la valeur bilineaire attendue ci-dessus —
    // c'est ce contraste qu'une regression de branchement ferait disparaitre.
    expect(Math.abs(expectedVy)).toBeGreaterThan(speed * 0.3);
  });

  it('la vitesse initiale posee par spawn reflete elle aussi le melange bilineaire, pas la lecture par cellule seule', () => {
    // Meme risque que le test precedent, pour `spawn` (tache 20) plutot que
    // `#recomputeSteering` (tache 19) : ce sont deux lectures DISTINCTES
    // dans `Horde`, donc deux endroits ou le branchement peut avoir ete
    // oublie independamment l'un de l'autre.
    //
    // Champ REEL (obstacles + BFS complet), pas deux cellules a la main : la
    // position de naissance vient de `formationPositions`, pas choisie par
    // ce test. Graine et cible choisies (script d'exploration du rapport de
    // la tache 25) pour que la position de naissance retombe pres d'un
    // virage du champ — sans obstacle a proximite, un grand nombre de
    // cellules voisines partagent exactement la meme direction et le
    // melange bilineaire coincide alors avec la lecture par cellule par
    // pure coincidence geometrique, ce qui aurait rendu ce test aveugle a la
    // regression qu'il vise.
    const MAP_SIZE = 2000;
    const CELL = 64;
    const cols = Math.ceil(MAP_SIZE / CELL);
    const rows = cols;
    const mask = generateObstacles(4, cols, rows);
    const field = new FlowField(MAP_SIZE, CELL);
    applyObstacles(field, mask);
    field.update(1900, 1900);

    const horde = new Horde(4);
    horde.spawn(
      order({ count: 1, formation: FORMATION.SCATTER, anchorX: 1000, anchorY: 1000 }),
      field,
    );

    const ex = horde.x[0] ?? 0;
    const ey = horde.y[0] ?? 0;

    // Valeur de reference : le MEME appel que celui que `spawn` doit faire,
    // a la MEME position — un test de branchement, pas une redite de la
    // formule (deja verifiee et mutee dans `shared/flowfield.test.ts`).
    const expected = new Float32Array(2);
    field.sampleDirection(ex, ey, expected);
    const speed = archetypeOf(0).speed;

    // Sanity : la lecture par cellule seule donnerait ici une direction
    // MESURABLEMENT differente du melange bilineaire attendu — sinon ce
    // test ne prouverait rien sur le branchement (voir le commentaire
    // ci-dessus).
    const perCellIdx = field.indexAt(ex, ey);
    const perCellX = field.dirX[perCellIdx] ?? 0;
    const perCellY = field.dirY[perCellIdx] ?? 0;
    const contrast = Math.hypot((expected[0] ?? 0) - perCellX, (expected[1] ?? 0) - perCellY);
    expect(contrast).toBeGreaterThan(0.1);

    expect(horde.vx[0] ?? 0).toBeCloseTo((expected[0] ?? 0) * speed, 3);
    expect(horde.vy[0] ?? 0).toBeCloseTo((expected[1] ?? 0) * speed, 3);
  });
});

describe('etape 5a, tache 3 : la marque elementaire et son expiration derivee', () => {
  it('applyMark ecrit les trois tableaux et pose l expiration a tick + MARK_DURATION_TICKS', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 3 }));

    horde.applyMark(1, ELEMENT.BRAISE, 2, 100);

    expect(horde.mark[1]).toBe(ELEMENT.BRAISE);
    expect(horde.markBy[1]).toBe(2);
    // Derive de la constante, JAMAIS le chiffre 60 : `MARK_DURATION_TICKS`
    // est un reglage de jeu que l'auteur ajustera a l'oeil (tache 11), et un
    // test qui le verrouille casse au premier reglage. Le depot vient de payer
    // exactement ca sur `WAVE1_MIN_COUNT`.
    expect(horde.markUntil[1]).toBe(100 + MARK_DURATION_TICKS);
    // Les voisins ne sont pas touches : `applyMark` ecrit UN creneau.
    expect(horde.mark[0]).toBe(ELEMENT.NEUTRE);
    expect(horde.mark[2]).toBe(ELEMENT.NEUTRE);
  });

  it('markBy distingue deux joueurs — c est ce que la Synergie consomme', () => {
    // ⚠️ Sans ce tableau, une reaction entre deux joueurs et une reaction en
    // solo sont indiscernables, et le §6.5 de l'orientation — « le coeur du
    // projet » — n'a plus de donnees (§7 de la spec). Deux marques posees par
    // deux joueurs differents doivent rester distinctes.
    const horde = new Horde(10);
    horde.spawn(order({ count: 2 }));

    horde.applyMark(0, ELEMENT.BRAISE, 0, 10);
    horde.applyMark(1, ELEMENT.BRAISE, 3, 10);

    expect(horde.markBy[0]).toBe(0);
    expect(horde.markBy[1]).toBe(3);
    expect(horde.markBy[0]).not.toBe(horde.markBy[1]);
  });

  it('une marque vaut encore au dernier tick de sa duree et plus au suivant', () => {
    // ⚠️ **LES DEUX BORNES.** Un test qui verifie seulement « ca expire un
    // jour » passe avec n'importe quelle duree — y compris une duree fausse
    // d'un tick, ou une comparaison `<=` au lieu de `<`.
    expect(MARK_DURATION_TICKS).toBeGreaterThan(0); // sinon les deux bornes se confondent
    const T = 500;
    const horde = new Horde(10);
    horde.spawn(order({ count: 1 }));

    horde.applyMark(0, ELEMENT.GIVRE, 1, T);

    expect(horde.markAt(0, T)).toBe(ELEMENT.GIVRE);
    expect(horde.markAt(0, T + MARK_DURATION_TICKS - 1)).toBe(ELEMENT.GIVRE);
    expect(horde.markAt(0, T + MARK_DURATION_TICKS)).toBe(ELEMENT.NEUTRE);
    expect(horde.markAt(0, T + MARK_DURATION_TICKS + 1)).toBe(ELEMENT.NEUTRE);
  });

  it('la marque vaut exactement MARK_DURATION_TICKS ticks, comptes un par un', () => {
    // Le compte ferme les deux bornes a la fois : un decalage d'un tick d'un
    // cote OU de l'autre change ce total, une duree fausse aussi. Toujours
    // derive de la constante, jamais du chiffre.
    const T = 7;
    const horde = new Horde(10);
    horde.spawn(order({ count: 1 }));
    horde.applyMark(0, ELEMENT.BRAISE, 0, T);

    let valides = 0;
    for (let tick = T; tick <= T + MARK_DURATION_TICKS * 2; tick++) {
      if (horde.markAt(0, tick) !== ELEMENT.NEUTRE) {
        valides++;
      }
    }

    expect(valides).toBe(MARK_DURATION_TICKS);
  });

  it('une entite jamais marquee ne porte aucun element, a aucun tick', () => {
    const horde = new Horde(10);
    horde.spawn(order({ count: 3 }));

    expect(horde.markAt(0, 0)).toBe(ELEMENT.NEUTRE);
    expect(horde.markAt(0, 10_000)).toBe(ELEMENT.NEUTRE);
  });

  it('rien ne balaie les marques perimees : l expiration est DERIVEE, pas effacee', () => {
    // ⚠️ Le pendant de `ZONE_LIFETIME_TICKS` : aucune passe ne parcourt la
    // horde pour nettoyer, aucun message ne dit qu'une marque est tombee. Les
    // tableaux gardent donc leur contenu au-dela de l'expiration, et c'est
    // `markAt` — et lui seul — qui repond. Un test qui lirait `horde.mark`
    // directement se croirait marque pour toujours.
    const horde = new Horde(10);
    horde.spawn(order({ count: 1 }));
    horde.applyMark(0, ELEMENT.BRAISE, 2, 0);

    const bienApres = MARK_DURATION_TICKS * 10;
    expect(horde.markAt(0, bienApres)).toBe(ELEMENT.NEUTRE);
    expect(horde.mark[0]).toBe(ELEMENT.BRAISE);
    expect(horde.markBy[0]).toBe(2);
  });

  it('une entite neuve dans un creneau recycle ne herite pas de la marque du mort', () => {
    const horde = new Horde(10);
    horde.spawn(order({ waveId: 1, count: 2 }));
    // Les DEUX entites sont marquees : sans ca, le compactage de `kill`
    // deplacerait une entite non marquee dans le creneau 0 et le test
    // passerait meme si `spawn` n'effacait rien — la fixture rendrait le cas
    // impossible.
    horde.applyMark(0, ELEMENT.BRAISE, 1, 0);
    horde.applyMark(1, ELEMENT.GIVRE, 3, 0);

    horde.kill([horde.entityIdAt(0), horde.entityIdAt(1)]);

    // Le cas qu'on croit creer, COMPTE et pas suppose : le creneau 0 est libre
    // ET porte encore une marque ENCORE VALIDE au tick ou l'on va renaitre.
    // Sans cette verification, une fixture ou la marque serait deja tombee (ou
    // le creneau deja propre) rendrait le test vert quoi que fasse `spawn`.
    expect(horde.count).toBe(0);
    expect(horde.mark[0]).toBe(ELEMENT.BRAISE);
    expect(horde.markBy[0]).toBe(1);
    expect(horde.markUntil[0]).toBeGreaterThan(1);

    horde.spawn(order({ waveId: 2, count: 1 }));

    // Le cas qu'on croit creer, COMPTE et pas suppose : le creneau reutilise
    // est bien celui qui portait une marque encore valide.
    expect(horde.count).toBe(1);
    expect(horde.mark[0]).toBe(ELEMENT.NEUTRE);
    expect(horde.markAt(0, 1)).toBe(ELEMENT.NEUTRE);
    expect(horde.markBy[0]).toBe(0);
    expect(horde.markUntil[0]).toBe(0);
  });
});

function meanDistanceTo(horde: Horde, x: number, y: number): number {
  let total = 0;
  for (let i = 0; i < horde.count; i++) {
    total += Math.hypot((horde.x[i] ?? 0) - x, (horde.y[i] ?? 0) - y);
  }
  return total / horde.count;
}

describe('Horde.step — le ralentissement des zones (etape 5a, tache 6)', () => {
  const GIVRE_FACTEUR = elementOf(ELEMENT.GIVRE).slowFactor;

  /** Une entite unique, immobile a `(x, y)`, avec sa vitesse posee a la main. */
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  /**
   * Avance `horde` des ticks `0` a `tick - 1`, puis rend la distance parcourue
   * au tick `tick`.
   *
   * ⚠️ **Le chauffage depuis le tick 0 n'est pas decoratif.** Une entite ne
   * recalcule sa trajectoire qu'un tick sur `STEERING_RECOMPUTE_TICKS`, selon
   * la phase de son identifiant : demarrer directement au tick vise laisse
   * `vx`/`vy` a zero, donc une distance parcourue nulle DES DEUX COTES — et
   * l'assertion passerait en ne comparant que deux zeros. C'est le motif de la
   * fixture qui masque, cinq fois rencontre dans ce depot.
   */
  /** Un seul pas, au tick `tick`, sans chauffage : rend la distance parcourue par l'entite 0. */
  function pasDe(horde: Horde, fields: FlowField[], tick: number, zones?: ZoneField): number {
    const x0 = horde.x[0] ?? 0;
    const y0 = horde.y[0] ?? 0;
    horde.step(DT, fields, tick, zones);
    return Math.hypot((horde.x[0] ?? 0) - x0, (horde.y[0] ?? 0) - y0);
  }

  function pasAu(horde: Horde, fields: FlowField[], tick: number, zones?: ZoneField): number {
    for (let t = 0; t < tick; t++) {
      horde.step(DT, fields, t, zones);
    }
    const x0 = horde.x[0] ?? 0;
    const y0 = horde.y[0] ?? 0;
    horde.step(DT, fields, tick, zones);
    const d = Math.hypot((horde.x[0] ?? 0) - x0, (horde.y[0] ?? 0) - y0);
    // Une distance nulle ne prouverait rien : la garde est ici, une fois, pour
    // tous les tests de ce bloc.
    expect(d).toBeGreaterThan(0);
    return d;
  }

  /**
   * Tick de mesure : au-dela du premier recalcul de trajectoire de l'entite,
   * pour que `vx`/`vy` soient poses. Derive de la constante, pas recopie.
   */
  const MESURE = STEERING_RECOMPUTE_TICKS + 2;

  it('une entite dans une zone de Givre avance exactement slowFactor fois moins loin', () => {
    const fields = fieldsTowards(5000, 1000);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 0, 0);

    const dLibre = pasAu(une(1000, 1000), fields, MESURE);
    const dGivree = pasAu(une(1000, 1000), fields, MESURE, zones);

    // Derive du facteur de la table, jamais recopie. Precision 3 : `Horde.x`
    // est un `Float32Array`, dont l'ulp autour de 1 000 px vaut ~6e-5.
    expect(dGivree).toBeCloseTo(dLibre * GIVRE_FACTEUR, 3);
  });

  /**
   * ⚠️ **`#computeSlow` doit decoder `zones.kind`, jamais le lire brut**
   * (tache 5 de l'etape 5b). `packZoneKind(GIVRE, reaction)` avec une
   * reaction non nulle vaut au moins 8 — hors de portee d'`ELEMENTS` (4
   * entrees aujourd'hui) tant que l'element tient sur 3 bits. Un
   * `#computeSlow` qui lirait l'octet brut leverait au lieu de ralentir ; le
   * bon code decode et retrouve exactement le meme ralentissement que
   * l'element seul.
   */
  it('ralentit pareil que l element seul quand la zone porte un type de reaction empaquete', () => {
    const fields = fieldsTowards(5000, 1000);
    const kind = packZoneKind(ELEMENT.GIVRE, 6);
    expect(kind).not.toBe(ELEMENT.GIVRE);
    const zones = new ZoneField();
    zones.spawn(kind, 1000, 1000, 0, 0);

    const dLibre = pasAu(une(1000, 1000), fields, MESURE);
    const dGivree = pasAu(une(1000, 1000), fields, MESURE, zones);

    expect(dGivree).toBeCloseTo(dLibre * GIVRE_FACTEUR, 3);
  });

  it('une entite HORS de la zone n est pas ralentie, a un pixel du bord', () => {
    // ⚠️ Un pixel dehors, pas mille : c'est ce qui rend le RAYON porteur, et
    // pas seulement le fait que la boucle ne ralentit pas tout le monde.
    const fields = fieldsTowards(5000, 1000);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, 1000, 1000, 0, 0);
    const depart = 1000 + ZONE_RADIUS + 1;

    expect(pasAu(une(depart, 1000), fields, MESURE, zones)).toBe(
      pasAu(une(depart, 1000), fields, MESURE),
    );
  });

  it('une zone de Braise ne ralentit personne — le facteur vient de la table, pas du fait d etre une zone', () => {
    const fields = fieldsTowards(5000, 1000);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.BRAISE, 1000, 1000, 0, 0);

    expect(pasAu(une(1000, 1000), fields, MESURE, zones)).toBe(
      pasAu(une(1000, 1000), fields, MESURE),
    );
  });

  it('ne ralentit PAS au tick de la pose, et ralentit au suivant', () => {
    // ⚠️ `slowsAt`, pas `aliveAt`. Le serveur pose ses zones APRES avoir fait
    // avancer sa horde : un client qui ralentirait des le `bornTick`
    // appliquerait un tick de ralentissement que le serveur n'a jamais joue.
    const fields = fieldsTowards(5000, 1000);
    const auTick = new ZoneField();
    auTick.spawn(ELEMENT.GIVRE, 1000, 1000, 0, MESURE);
    const auPrecedent = new ZoneField();
    auPrecedent.spawn(ELEMENT.GIVRE, 1000, 1000, 0, MESURE - 1);

    const reference = pasAu(une(1000, 1000), fields, MESURE);
    expect(pasAu(une(1000, 1000), fields, MESURE, auTick)).toBe(reference);
    expect(pasAu(une(1000, 1000), fields, MESURE, auPrecedent)).toBeLessThan(reference);
  });

  it('une zone perimee laissee dans la reserve ne ralentit plus rien, au tick pres', () => {
    // ⚠️ **Deux pas CONSECUTIFS de la MEME entite**, et pas deux hordes
    // paralleles : une horde temoin qui n'aurait jamais vu la zone aurait
    // suivi un autre chemin pendant tout le chauffage, donc echantillonne le
    // champ ailleurs — les deux distances differeraient de quelques 1e-5 sans
    // que ca dise quoi que ce soit de la peremption.
    //
    // La zone nait au tick `NAISSANCE` et vit `ZONE_LIFETIME_TICKS` ticks :
    // elle ralentit encore au dernier, plus au suivant. `Uint32Array` oblige,
    // `NAISSANCE` doit rester positif — un tick negatif y reboucle vers quatre
    // milliards et rendrait la zone « pas encore nee ».
    const NAISSANCE = 5;
    const dernierVivant = NAISSANCE + ZONE_LIFETIME_TICKS - 1;
    const fields = fieldsTowards(5000, 1000);
    const zones = new ZoneField();
    // ⚠️ **Une TRAINEE de zones, pas une seule.** L'entite avance de quelques
    // pixels par tick : sur une duree de vie entiere elle parcourt plusieurs
    // fois `ZONE_RADIUS` et serait sortie d'un disque unique bien avant qu'il
    // ne perime — le test aurait alors compare « dedans » a « dehors » en
    // croyant comparer « vivante » a « perimee ». Espacees d'exactement
    // `ZONE_RADIUS` : la fusion demande une distance STRICTEMENT inferieure,
    // donc rien ne fusionne et la couverture reste continue (§5.1 bis).
    for (let k = 0; k <= 8; k++) {
      zones.spawn(ELEMENT.GIVRE, 1000 + k * ZONE_RADIUS, 1000, 0, NAISSANCE);
    }
    expect(zones.count).toBe(9);

    const horde = une(1000, 1000);
    for (let t = 0; t < dernierVivant; t++) {
      horde.step(DT, fields, t, zones);
    }
    const dVivante = pasDe(horde, fields, dernierVivant, zones);
    const vitesse = [horde.vx[0], horde.vy[0]];
    const dMorte = pasDe(horde, fields, dernierVivant + 1, zones);

    // Aucun `expire` : les zones mortes sont bien encore dans la reserve.
    expect(zones.count).toBe(9);
    // Garde-fou : les deux pas doivent tenir la MEME vitesse, sinon la
    // comparaison mesurerait un recalcul de trajectoire, pas la peremption.
    expect([horde.vx[0], horde.vy[0]]).toEqual(vitesse);
    expect(dVivante).toBeGreaterThan(0);
    expect(dVivante).toBeCloseTo(dMorte * GIVRE_FACTEUR, 3);
  });

  it('deux zones qui se recouvrent rendent le MINIMUM, pas leur produit', () => {
    // ⚠️ Le produit dependrait de l'ordre du tableau — et l'ordre n'est PAS
    // garanti identique des deux cotes du fil (compaction par echange,
    // expiration decalee cote client). Le minimum est commutatif exactement.
    const fields = fieldsTowards(5000, 1000);
    const deux = new ZoneField();
    deux.spawn(ELEMENT.GIVRE, 1000, 1000, 0, 0);
    // Le centre tombe HORS du premier disque (distance = `ZONE_RADIUS`), donc
    // rien ne fusionne — mais les deux disques couvrent le point de depart.
    deux.spawn(ELEMENT.GIVRE, 1000 + ZONE_RADIUS, 1000, 0, 0);
    expect(deux.count).toBe(2);
    const seule = new ZoneField();
    seule.spawn(ELEMENT.GIVRE, 1000, 1000, 0, 0);

    const depart = 1000 + ZONE_RADIUS / 2;
    // Deux zones ne ralentissent pas plus qu'une : `min(f, f) === f`, alors
    // que `f * f` serait strictement plus petit.
    expect(pasAu(une(depart, 1000), fields, MESURE, deux)).toBe(
      pasAu(une(depart, 1000), fields, MESURE, seule),
    );
  });

  it('sans zones, le pas est BIT pour BIT celui d avant la tache 6', () => {
    // Le contrat de replication de l'etape 2 : le chemin sans zones ne doit
    // pas bouger d'un ulp. `x * dt * 1` est exact en IEEE754.
    const fields = fieldsTowards(4000, 4000);
    const avec = new Horde(4000);
    const sans = new Horde(4000);
    avec.spawn(order({ count: 300 }));
    sans.spawn(order({ count: 300 }));
    const vide = new ZoneField();

    for (let t = 0; t < 60; t++) {
      avec.step(DT, fields, t, vide);
      sans.step(DT, fields, t);
    }

    for (let i = 0; i < sans.count; i++) {
      expect(avec.x[i]).toBe(sans.x[i]);
      expect(avec.y[i]).toBe(sans.y[i]);
    }
  });

  it('spawnCatchingUp ralentit aussi les pas rattrapes', () => {
    // ⚠️ Sans l'appel a `#computeSlow` dans la boucle de rattrapage, celle-ci
    // utiliserait le facteur du DERNIER `step` — un etat remanent applique a
    // des entites qui viennent de naitre.
    const fields = fieldsTowards(5000, 1000);
    const o = order({ count: 20, anchorX: 1000, anchorY: 1000, spawnTick: 1 });

    // ⚠️ **La zone est posee sur une position REELLE d'entite, pas devinee.**
    // `FORMATION.SCATTER` disperse les vingt entites sur des centaines de
    // pixels : une zone posee sur l'ancre pourrait n'en couvrir aucune, et le
    // test passerait en ne comparant que deux hordes identiques.
    const reperage = new Horde(100);
    reperage.spawn(o, fields[0]);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.GIVRE, reperage.x[0] ?? 0, reperage.y[0] ?? 0, 0, 0);

    const givree = new Horde(100);
    const temoin = new Horde(100);
    givree.spawnCatchingUp(o, 5, DT, fields, zones);
    temoin.spawnCatchingUp(o, 5, DT, fields);

    expect(temoin.count).toBe(20);
    const ecart = Math.hypot(
      (givree.x[0] ?? 0) - (temoin.x[0] ?? 0),
      (givree.y[0] ?? 0) - (temoin.y[0] ?? 0),
    );
    expect(ecart).toBeGreaterThan(0);
  });
});

/**
 * La Supraconduction (Givre + Foudre, tache 7 de l'etape 5b) : `slowFactor:
 * 0` sur le champ qu'elle laisse. Elle n'ajoute AUCUN mecanisme
 * d'immobilisation : c'est le MEME `#computeSlow` que le bloc Givre
 * ci-dessus, seul le facteur derive (`zoneSlowFactor`, `shared/reactions.ts`)
 * change. Le describe est separe parce que le SUJET differe (une reaction,
 * pas un element seul), pas parce que le mecanisme differe.
 */
describe('Horde.step — la Supraconduction fige le deplacement (etape 5b, tache 7)', () => {
  /** Une entite unique, immobile a `(x, y)`, avec sa vitesse posee a la main. */
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  /**
   * Avance `horde` des ticks `0` a `tick - 1` (le meme chauffage que `pasAu`
   * du bloc Givre, voir sa doc), puis rend la distance parcourue au tick
   * `tick`.
   *
   * ⚠️ **Sans la garde `toBeGreaterThan(0)` de `pasAu`, deliberement** : ici
   * la distance ATTENDUE est zero. Une garde qui l'interdirait ferait
   * rougir le test qu'elle est censee servir.
   */
  function pasFigeAu(horde: Horde, fields: FlowField[], tick: number, zones: ZoneField): number {
    for (let t = 0; t < tick; t++) {
      horde.step(DT, fields, t, zones);
    }
    const x0 = horde.x[0] ?? 0;
    const y0 = horde.y[0] ?? 0;
    horde.step(DT, fields, tick, zones);
    return Math.hypot((horde.x[0] ?? 0) - x0, (horde.y[0] ?? 0) - y0);
  }

  const MESURE = STEERING_RECOMPUTE_TICKS + 2;

  it('immobilise totalement, quel que soit l element porte par le nibble (Givre OU Foudre declenche)', () => {
    // ⚠️ **Le point precis de `zoneSlowFactor` : le nibble d'element de la
    // zone porte celui du DECLENCHEUR** (`ReactionTrigger.element`,
    // `back/src/combat.ts`), Givre OU Foudre selon l'ordre d'arrivee des
    // deux elements. `elementOf(ELEMENT.GIVRE).slowFactor` (0,6) et
    // `elementOf(ELEMENT.FOUDRE).slowFactor` (1) sont TOUS DEUX faux pour la
    // Supraconduction : seule la combinaison par minimum avec
    // `ReactionDef.zoneSlowFactor` (0) rend le gel total, dans les deux cas.
    const fields = fieldsTowards(5000, 1000);
    const givreDeclenche = new ZoneField();
    givreDeclenche.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);
    const foudreDeclenche = new ZoneField();
    foudreDeclenche.spawn(packZoneKind(ELEMENT.FOUDRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);

    expect(pasFigeAu(une(1000, 1000), fields, MESURE, givreDeclenche)).toBe(0);
    expect(pasFigeAu(une(1000, 1000), fields, MESURE, foudreDeclenche)).toBe(0);
  });

  it('une entite HORS de la zone n est pas figee, a un pixel du bord', () => {
    const fields = fieldsTowards(5000, 1000);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);
    const depart = 1000 + ZONE_RADIUS + 1;

    expect(pasFigeAu(une(depart, 1000), fields, MESURE, zones)).toBeGreaterThan(0);
  });

  it('ne fige PAS au tick de la pose, et fige au suivant — meme `slowsAt` que le Givre', () => {
    const fields = fieldsTowards(5000, 1000);
    const auTick = new ZoneField();
    auTick.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, MESURE);
    const auPrecedent = new ZoneField();
    auPrecedent.spawn(
      packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION),
      1000,
      1000,
      0,
      MESURE - 1,
    );

    expect(pasFigeAu(une(1000, 1000), fields, MESURE, auTick)).toBeGreaterThan(0);
    expect(pasFigeAu(une(1000, 1000), fields, MESURE, auPrecedent)).toBe(0);
  });

  /**
   * Point de revue n° 4 du plan : une zone de Poix et une de Supraconduction
   * au meme point. La Poix (`slowFactor` neutre, 1) ne doit ni annuler le
   * gel ni s'y confondre — le minimum de `#computeSlow` doit rendre EXACTEMENT
   * le facteur de la Supraconduction (0), quel que soit l'ordre de pose.
   *
   * ⚠️ **Posees dans les DEUX ordres**, comme la regle generale de cette
   * etape l'exige des que deux elements se recouvrent dans un decor : voir le
   * rapport de la tache 7 sur `ZoneField.ampAt`.
   */
  it('une zone de Poix superposee ne degele rien : le minimum reste 0, dans les deux ordres de pose', () => {
    const fields = fieldsTowards(5000, 1000);

    const poixPuisSupra = new ZoneField();
    poixPuisSupra.spawn(ELEMENT.POIX, 1000, 1000, 0, 0);
    poixPuisSupra.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);

    const supraPuisPoix = new ZoneField();
    supraPuisPoix.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);
    supraPuisPoix.spawn(ELEMENT.POIX, 1000, 1000, 0, 0);

    expect(pasFigeAu(une(1000, 1000), fields, MESURE, poixPuisSupra)).toBe(0);
    expect(pasFigeAu(une(1000, 1000), fields, MESURE, supraPuisPoix)).toBe(0);
  });
});

/**
 * Gel profond (Givre + Vif-argent) et Mortier vif (Poix + Chaux), tache 6 de
 * l'etape 5c : `slowFactor: 0` sur le champ qu'elles laissent — le MEME
 * `#computeSlow` que le bloc Supraconduction ci-dessus, seul le facteur
 * derive (`zoneSlowFactor`, `shared/reactions.ts`) change. Le describe est
 * separe pour la meme raison que Supraconduction l'etait du Givre : le SUJET
 * differe (deux reactions de plus), pas le mecanisme.
 */
describe('Horde.step — Gel profond et Mortier vif figent le deplacement (tache 6 de l etape 5c)', () => {
  /** Une entite unique, immobile a `(x, y)`, avec sa vitesse posee a la main. */
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  /** Meme forme que `pasFigeAu` du bloc Supraconduction ci-dessus. */
  function pasFigeAu(horde: Horde, fields: FlowField[], tick: number, zones: ZoneField): number {
    for (let t = 0; t < tick; t++) {
      horde.step(DT, fields, t, zones);
    }
    const x0 = horde.x[0] ?? 0;
    const y0 = horde.y[0] ?? 0;
    horde.step(DT, fields, tick, zones);
    return Math.hypot((horde.x[0] ?? 0) - x0, (horde.y[0] ?? 0) - y0);
  }

  const MESURE = STEERING_RECOMPUTE_TICKS + 2;

  it('Gel profond immobilise totalement, quel que soit l element porte par le nibble (Givre OU Vif-argent declenche)', () => {
    const fields = fieldsTowards(5000, 1000);
    const givreDeclenche = new ZoneField();
    givreDeclenche.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, 0);
    const vifArgentDeclenche = new ZoneField();
    vifArgentDeclenche.spawn(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.GEL_PROFOND),
      1000,
      1000,
      0,
      0,
    );

    expect(pasFigeAu(une(1000, 1000), fields, MESURE, givreDeclenche)).toBe(0);
    expect(pasFigeAu(une(1000, 1000), fields, MESURE, vifArgentDeclenche)).toBe(0);
  });

  it('Mortier vif immobilise totalement, dans les DEUX ordres (Poix OU Chaux declenche)', () => {
    const fields = fieldsTowards(5000, 1000);
    const poixDeclenche = new ZoneField();
    poixDeclenche.spawn(packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF), 1000, 1000, 0, 0);
    const chauxDeclenche = new ZoneField();
    chauxDeclenche.spawn(packZoneKind(ELEMENT.CHAUX, REACTION.MORTIER_VIF), 1000, 1000, 0, 0);

    expect(pasFigeAu(une(1000, 1000), fields, MESURE, poixDeclenche)).toBe(0);
    expect(pasFigeAu(une(1000, 1000), fields, MESURE, chauxDeclenche)).toBe(0);
  });

  it('une entite HORS de la zone de Gel profond n est pas figee, a un pixel du bord', () => {
    const fields = fieldsTowards(5000, 1000);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, 0);
    const depart = 1000 + ZONE_RADIUS + 1;

    expect(pasFigeAu(une(depart, 1000), fields, MESURE, zones)).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **LE test qui assene LA DUREE, pas seulement l effet — §5 de la
   * spec : « plus forte ou plus longue que Supraconduction ».**
   * `zoneSlowFactor: 0` est un plancher ABSOLU des DEUX cotes : rien ne peut
   * geler « plus fort » que zero, donc si les deux reactions ne se
   * separaient que par cette assertion, Gel profond serait du CONTENU MORT
   * a cote de la Supraconduction (§5 de la spec de l'etape 5c le dit en
   * toutes lettres). La separation reelle est `zoneLifetimeTicks` : la
   * Supraconduction degele a la duree GENERIQUE (`ZONE_LIFETIME_TICKS`, 90
   * ticks), Gel profond continue jusqu'a `SURCHAUFFE_ZONE_LIFETIME_TICKS`
   * (135 ticks, reutilisee — voir `REACTION_DEFS`). `MESURE` tombe entre les
   * deux : la Supraconduction a deja degele, Gel profond gele encore.
   */
  it('Gel profond reste gele au-dela de la duree de la Supraconduction : la DUREE les separe, pas l intensite', () => {
    const fields = fieldsTowards(5000, 1000);
    const MESURE_DUREE = ZONE_LIFETIME_TICKS + 2;
    expect(MESURE_DUREE).toBeLessThan(SURCHAUFFE_ZONE_LIFETIME_TICKS);

    const supraconduction = new ZoneField();
    supraconduction.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);
    const gelProfond = new ZoneField();
    gelProfond.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, 0);

    // La Supraconduction a degele : ce pas-la avance normalement.
    expect(pasFigeAu(une(1000, 1000), fields, MESURE_DUREE, supraconduction)).toBeGreaterThan(0);
    // Gel profond gele encore, MEME instant, MEME geometrie.
    expect(pasFigeAu(une(1000, 1000), fields, MESURE_DUREE, gelProfond)).toBe(0);
  });

  it('ne fige PAS au tick de la pose, et fige au suivant — meme `slowsAt` que la Supraconduction', () => {
    const fields = fieldsTowards(5000, 1000);
    const auTick = new ZoneField();
    auTick.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, MESURE);
    const auPrecedent = new ZoneField();
    auPrecedent.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, MESURE - 1);

    expect(pasFigeAu(une(1000, 1000), fields, MESURE, auTick)).toBeGreaterThan(0);
    expect(pasFigeAu(une(1000, 1000), fields, MESURE, auPrecedent)).toBe(0);
  });
});

/**
 * Verglas (Givre + Poix, tache 8 de l'etape 5b) : « les ennemis derapent ».
 * `ReactionDef.zoneInertiaDamping` NON neutre intercepte
 * `Horde#recomputeSteering` : au tick ou l'entite recalculerait sa
 * trajectoire, elle GARDE sa vitesse precedente a la place, amortie d'un
 * facteur — voir le docbloc de la methode. `zoneSlowFactor` reste par
 * ailleurs epingle a celui du Givre (`shared/reactions.test.ts` le prouve a
 * l'unite) : deux mecanismes distincts pour les deux moities de la meme
 * reaction — « derapent » ici (VOYAGE), « et se percutent » cote serveur
 * seul (`back/src/combat.test.ts`, ne voyage PAS).
 */
describe('Horde.step — Verglas fait deraper la horde (etape 5b, tache 8)', () => {
  /** Une entite unique, immobile a `(x, y)`. */
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  const K = STEERING_RECOMPUTE_TICKS;

  /**
   * Le premier tick de recalcul de l'entite 0 strictement APRES `apres` —
   * assez tard pour poser une zone dont `bornTick < tick` (la regle
   * `slowsAt`, voir `ZoneField.slowsAt`).
   */
  function prochainRecalcul(horde: Horde, apres: number): number {
    const phase = horde.entityIdAt(0) % K;
    let tick = phase;
    while (tick <= apres) {
      tick += K;
    }
    return tick;
  }

  it('au tick de recalcul, garde sa vitesse precedente amortie de VERGLAS_INERTIA_DAMPING, pas la direction fraiche du champ', () => {
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000, 1000);
    const tick = prochainRecalcul(horde, 0);
    // Vitesse posee a la main, DELIBEREMENT hors de la direction du champ —
    // c'est ce qui separe « garder » de « recalculer ».
    horde.vx[0] = 0;
    horde.vy[0] = -80;
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 1000, 1000, 0, 0);

    horde.step(DT, fields, tick, zones);

    expect(VERGLAS_INERTIA_DAMPING).toBeLessThan(1);
    // Arithmetique EXACTE (a l'arrondi Float32 pres) : la vitesse tenue,
    // multipliee par le facteur, rien de plus.
    expect(horde.vx[0]).toBeCloseTo(0, 5);
    expect(horde.vy[0]).toBeCloseTo(-80 * VERGLAS_INERTIA_DAMPING, 4);
  });

  it('temoin SANS zone : le meme tick de recalcul EFFACE la vitesse posee a la main', () => {
    // ⚠️ **La garde anti-fixture de ce bloc.** Sans elle, le test precedent
    // ne prouverait rien : peut-etre que `#recomputeSteering` ignore
    // TOUJOURS la vitesse tenue, zone ou pas. Ici, aucun voisin ne repousse
    // l'entite : la vitesse recalculee doit retomber a la norme exacte de
    // l'archetype (`Math.hypot(vx, vy) === speed`), jamais a la vitesse
    // amortie posee a la main.
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000, 1000);
    const tick = prochainRecalcul(horde, 0);
    horde.vx[0] = 0;
    horde.vy[0] = -80;

    horde.step(DT, fields, tick);

    const speed = archetypeOf(horde.archetype[0] ?? 0).speed;
    expect(Math.hypot(horde.vx[0] ?? 0, horde.vy[0] ?? 0)).toBeCloseTo(speed, 3);
    expect(horde.vy[0]).not.toBeCloseTo(-80 * VERGLAS_INERTIA_DAMPING, 4);
  });

  it('une entite HORS de la zone n est pas affectee, a un pixel du bord : recalcul normal', () => {
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000 + ZONE_RADIUS + 1, 1000);
    const tick = prochainRecalcul(horde, 0);
    horde.vx[0] = 0;
    horde.vy[0] = -80;
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 1000, 1000, 0, 0);

    horde.step(DT, fields, tick, zones);

    const speed = archetypeOf(horde.archetype[0] ?? 0).speed;
    expect(Math.hypot(horde.vx[0] ?? 0, horde.vy[0] ?? 0)).toBeCloseTo(speed, 3);
  });

  it('PILE sur le cercle (distance exacte ZONE_RADIUS) : la borne est STRICTE, recalcul normal', () => {
    // ⚠️ Meme borne stricte que `ZoneField.slowsAt`/`ampAt`/`armorReductionAt`
    // (`dx² + dy² < r²`, jamais `<=`) — testee ICI a la distance EXACTE,
    // contrairement au test precedent qui ne prouve que « un pixel dehors »
    // et ne peut pas separer `<` de `<=`.
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000 + ZONE_RADIUS, 1000);
    const tick = prochainRecalcul(horde, 0);
    horde.vx[0] = 0;
    horde.vy[0] = -80;
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 1000, 1000, 0, 0);

    horde.step(DT, fields, tick, zones);

    const speed = archetypeOf(horde.archetype[0] ?? 0).speed;
    expect(Math.hypot(horde.vx[0] ?? 0, horde.vy[0] ?? 0)).toBeCloseTo(speed, 3);
  });

  it('ne s applique PAS au tick de la pose, s applique au suivant — meme `slowsAt` que le Givre et la Supraconduction', () => {
    const fields = fieldsTowards(5000, 1000);

    const auTick = une(1000, 1000);
    const tickAuTick = prochainRecalcul(auTick, 0);
    auTick.vx[0] = 0;
    auTick.vy[0] = -80;
    const zonesAuTick = new ZoneField();
    zonesAuTick.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 1000, 1000, 0, tickAuTick);
    auTick.step(DT, fields, tickAuTick, zonesAuTick);
    const speed = archetypeOf(auTick.archetype[0] ?? 0).speed;
    // La zone existe mais ne RALENTIT/DERAPE pas encore : recalcul normal.
    expect(Math.hypot(auTick.vx[0] ?? 0, auTick.vy[0] ?? 0)).toBeCloseTo(speed, 3);

    const auPrecedent = une(1000, 1000);
    const tickAuPrecedent = prochainRecalcul(auPrecedent, 0);
    auPrecedent.vx[0] = 0;
    auPrecedent.vy[0] = -80;
    const zonesAuPrecedent = new ZoneField();
    zonesAuPrecedent.spawn(
      packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS),
      1000,
      1000,
      0,
      tickAuPrecedent - 1,
    );
    auPrecedent.step(DT, fields, tickAuPrecedent, zonesAuPrecedent);
    expect(auPrecedent.vy[0]).toBeCloseTo(-80 * VERGLAS_INERTIA_DAMPING, 4);
  });

  /**
   * Le piege de la tache 8 (R13), au point d'usage cette fois, pas
   * seulement en unite sur `zoneSlowFactor`/`zoneInertiaDamping`
   * (`shared/reactions.test.ts`) : le nibble d'element de la zone porte
   * celui du DECLENCHEUR (Givre OU Poix selon l'ordre d'arrivee).
   */
  it('le meme amortissement, quel que soit l element porte par le nibble (Givre OU Poix declenche)', () => {
    const fields = fieldsTowards(5000, 1000);

    const givreDeclenche = une(1000, 1000);
    const tick1 = prochainRecalcul(givreDeclenche, 0);
    givreDeclenche.vx[0] = 0;
    givreDeclenche.vy[0] = -80;
    const zonesGivre = new ZoneField();
    zonesGivre.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS), 1000, 1000, 0, 0);
    givreDeclenche.step(DT, fields, tick1, zonesGivre);

    const poixDeclenche = une(1000, 1000);
    const tick2 = prochainRecalcul(poixDeclenche, 0);
    poixDeclenche.vx[0] = 0;
    poixDeclenche.vy[0] = -80;
    const zonesPoix = new ZoneField();
    zonesPoix.spawn(packZoneKind(ELEMENT.POIX, REACTION.VERGLAS), 1000, 1000, 0, 0);
    poixDeclenche.step(DT, fields, tick2, zonesPoix);

    expect(givreDeclenche.vy[0]).toBeCloseTo(-80 * VERGLAS_INERTIA_DAMPING, 4);
    expect(poixDeclenche.vy[0]).toBeCloseTo(-80 * VERGLAS_INERTIA_DAMPING, 4);
  });

  it('spawnCatchingUp fait aussi deraper les pas rattrapes', () => {
    // ⚠️ Meme raisonnement que le rattrapage du Givre (tache 6) : sans le
    // parametre `zones` passe a `#recomputeSteering` depuis la boucle de
    // rattrapage, celle-ci recalculerait la trajectoire depuis le champ pour
    // chaque pas manque, meme dans une flaque de Verglas.
    const fields = fieldsTowards(5000, 1000);
    const o = order({ count: 20, anchorX: 1000, anchorY: 1000, spawnTick: 1 });

    const reperage = new Horde(100);
    reperage.spawn(o, fields[0]);
    const zones = new ZoneField();
    zones.spawn(
      packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS),
      reperage.x[0] ?? 0,
      reperage.y[0] ?? 0,
      0,
      0,
    );

    const derapee = new Horde(100);
    const temoin = new Horde(100);
    derapee.spawnCatchingUp(o, 5, DT, fields, zones);
    temoin.spawnCatchingUp(o, 5, DT, fields);

    expect(temoin.count).toBe(20);
    const ecart = Math.hypot(
      (derapee.x[0] ?? 0) - (temoin.x[0] ?? 0),
      (derapee.y[0] ?? 0) - (temoin.y[0] ?? 0),
    );
    expect(ecart).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **Le test precedent ne separe PAS l'inertie du `zoneSlowFactor`** —
   * une derive de position peut venir du seul ralentissement (qui, lui,
   * continue de passer par `#computeSlow(zones, tick)`, jamais touche par le
   * parametre `zones` de `#recomputeSteering`). Celui-ci isole l'inertie en
   * verifiant la NORME de la vitesse TENUE elle-meme : sans zone, un
   * recalcul normal (aucun voisin) rend une norme EXACTEMENT egale a la
   * vitesse de l'archetype ; avec Verglas, au moins un recalcul manque tombe
   * dans la flaque et l'amortit — la norme decroche strictement.
   */
  it('spawnCatchingUp amortit la vitesse TENUE elle-meme, pas seulement la position qui en decoule', () => {
    const fields = fieldsTowards(5000, 1000);
    const missedTicks = STEERING_RECOMPUTE_TICKS + 2;
    const o = order({ count: 1, anchorX: 1000, anchorY: 1000, spawnTick: 1 });

    const reperage = new Horde(10);
    reperage.spawn(o, fields[0]);
    const zones = new ZoneField();
    zones.spawn(
      packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS),
      reperage.x[0] ?? 0,
      reperage.y[0] ?? 0,
      0,
      0,
    );

    const derapee = new Horde(10);
    const temoin = new Horde(10);
    derapee.spawnCatchingUp(o, missedTicks, DT, fields, zones);
    temoin.spawnCatchingUp(o, missedTicks, DT, fields);

    expect(temoin.count).toBe(1);
    const speed = archetypeOf(0).speed;
    expect(Math.hypot(temoin.vx[0] ?? 0, temoin.vy[0] ?? 0)).toBeCloseTo(speed, 3);
    expect(Math.hypot(derapee.vx[0] ?? 0, derapee.vy[0] ?? 0)).toBeLessThan(speed - 0.01);
  });
});

/**
 * La Chaux (tache 1 de l'etape 5c) : « il fuit » — substitution du VECTEUR
 * DE CHAMP au moment ou `Horde#recomputeSteering` le lit, jamais une
 * ecriture dans `targetField` (qui se recalcule a chaque tick depuis les
 * positions des joueurs — voir le docbloc de la methode). Contrairement au
 * Verglas juste au-dessus (qui INTERCEPTE avant de lire le champ), la Chaux
 * laisse la repulsion entre voisins intacte : seule la POURSUITE du joueur
 * s'inverse.
 */
describe('Horde.step — la Chaux fait fuir (etape 5c, tache 1)', () => {
  /** Une entite unique, immobile a `(x, y)`. */
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  const K = STEERING_RECOMPUTE_TICKS;

  /** Le premier tick de recalcul de l'entite 0 strictement APRES `apres`. */
  function prochainRecalcul(horde: Horde, apres: number): number {
    const phase = horde.entityIdAt(0) % K;
    let tick = phase;
    while (tick <= apres) {
      tick += K;
    }
    return tick;
  }

  it('inverse exactement la vitesse calculee : l oppose de celle d un temoin sans zone', () => {
    const fields = fieldsTowards(5000, 1000);
    const fuyante = une(1000, 1000);
    const temoin = une(1000, 1000);
    const tick = prochainRecalcul(fuyante, 0);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.CHAUX, 1000, 1000, 0, 0);

    fuyante.step(DT, fields, tick, zones);
    temoin.step(DT, fields, tick);

    expect(temoin.vx[0]).not.toBe(0);
    // Arithmetique EXACTE : une seule entite, aucun voisin, la repulsion est
    // nulle des deux cotes — seul le signe du champ differe.
    expect(fuyante.vx[0]).toBe(-(temoin.vx[0] ?? 0));
    expect(fuyante.vy[0]).toBe(-(temoin.vy[0] ?? 0));
  });

  it('une entite HORS de la zone n est pas affectee, a un pixel du bord', () => {
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000 + ZONE_RADIUS + 1, 1000);
    const temoin = une(1000 + ZONE_RADIUS + 1, 1000);
    const tick = prochainRecalcul(horde, 0);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.CHAUX, 1000, 1000, 0, 0);

    horde.step(DT, fields, tick, zones);
    temoin.step(DT, fields, tick);

    expect(horde.vx[0]).toBe(temoin.vx[0]);
    expect(horde.vy[0]).toBe(temoin.vy[0]);
  });

  it('PILE sur le cercle (distance exacte ZONE_RADIUS) : la borne est STRICTE, pas de fuite', () => {
    // ⚠️ Meme borne stricte que `ZoneField.slowsAt`/`ampAt`/`armorReductionAt`
    // (`dx² + dy² < r²`, jamais `<=`), testee ICI a la distance EXACTE.
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000 + ZONE_RADIUS, 1000);
    const temoin = une(1000 + ZONE_RADIUS, 1000);
    const tick = prochainRecalcul(horde, 0);
    const zones = new ZoneField();
    zones.spawn(ELEMENT.CHAUX, 1000, 1000, 0, 0);

    horde.step(DT, fields, tick, zones);
    temoin.step(DT, fields, tick);

    expect(horde.vx[0]).toBe(temoin.vx[0]);
    expect(horde.vy[0]).toBe(temoin.vy[0]);
  });

  it('ne s applique PAS au tick de la pose, s applique au suivant — meme `slowsAt` que le Givre/la Supraconduction/Verglas', () => {
    const fields = fieldsTowards(5000, 1000);

    const auTick = une(1000, 1000);
    const tickAuTick = prochainRecalcul(auTick, 0);
    const zonesAuTick = new ZoneField();
    zonesAuTick.spawn(ELEMENT.CHAUX, 1000, 1000, 0, tickAuTick);
    auTick.step(DT, fields, tickAuTick, zonesAuTick);
    const temoinAuTick = une(1000, 1000);
    temoinAuTick.step(DT, fields, tickAuTick);
    // La zone existe mais ne fuit pas encore : recalcul normal, IDENTIQUE au
    // temoin.
    expect(auTick.vx[0]).toBe(temoinAuTick.vx[0]);
    expect(auTick.vy[0]).toBe(temoinAuTick.vy[0]);

    const auPrecedent = une(1000, 1000);
    const tickAuPrecedent = prochainRecalcul(auPrecedent, 0);
    const zonesAuPrecedent = new ZoneField();
    zonesAuPrecedent.spawn(ELEMENT.CHAUX, 1000, 1000, 0, tickAuPrecedent - 1);
    auPrecedent.step(DT, fields, tickAuPrecedent, zonesAuPrecedent);
    const temoinAuPrecedent = une(1000, 1000);
    temoinAuPrecedent.step(DT, fields, tickAuPrecedent);
    expect(auPrecedent.vx[0]).toBe(-(temoinAuPrecedent.vx[0] ?? 0));
    expect(auPrecedent.vy[0]).toBe(-(temoinAuPrecedent.vy[0] ?? 0));
  });

  /**
   * Point de revue n°4 du plan de l'etape 5c, ASSENE : le gel de la
   * Supraconduction gagne SUR la fuite de la Chaux PAR CONSTRUCTION — pas
   * par une regle de priorite ecrite quelque part, mais parce que
   * `#advanceByVelocity` multiplie `vx`/`vy` par `#slow` (0, gel total)
   * APRES que `#recomputeSteering` a deja fige leur DIRECTION : une vitesse
   * inversee dont la norme finale est nulle produit un deplacement nul,
   * dans les DEUX ordres de pose des zones.
   */
  it('le gel de la Supraconduction gagne sur la fuite de la Chaux : deplacement NUL, dans les deux ordres', () => {
    const fields = fieldsTowards(5000, 1000);
    const MESURE = K + 2;

    function pasAu(horde: Horde, tick: number, zones: ZoneField): number {
      for (let t = 0; t < tick; t++) {
        horde.step(DT, fields, t, zones);
      }
      const x0 = horde.x[0] ?? 0;
      const y0 = horde.y[0] ?? 0;
      horde.step(DT, fields, tick, zones);
      return Math.hypot((horde.x[0] ?? 0) - x0, (horde.y[0] ?? 0) - y0);
    }

    const chauxPuisSupra = new ZoneField();
    chauxPuisSupra.spawn(ELEMENT.CHAUX, 1000, 1000, 0, 0);
    chauxPuisSupra.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);

    const supraPuisChaux = new ZoneField();
    supraPuisChaux.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION), 1000, 1000, 0, 0);
    supraPuisChaux.spawn(ELEMENT.CHAUX, 1000, 1000, 0, 0);

    expect(pasAu(une(1000, 1000), MESURE, chauxPuisSupra)).toBe(0);
    expect(pasAu(une(1000, 1000), MESURE, supraPuisChaux)).toBe(0);
  });
});

/**
 * Aveuglement (Chaux + Vif-argent, tache 6 de l'etape 5c) : « la fuite,
 * plus forte ou plus longue que la Chaux seule » (§5 de la spec). Le MEME
 * mecanisme que le bloc Chaux ci-dessus (`zoneFieldSign`, substitution du
 * VECTEUR DE CHAMP) — seule la duree la distingue (`zoneFieldSign` n'a que
 * deux valeurs, +1/-1, rien n'est « plus fort » que -1). Le describe est
 * separe pour la meme raison que Gel profond l'etait de la Supraconduction :
 * le SUJET differe (une reaction a DEUX elements, dont un seul — la Chaux —
 * fuit), pas le mecanisme.
 */
describe('Horde.step — Aveuglement fait fuir plus longtemps que la Chaux seule (tache 6 de l etape 5c)', () => {
  /** Une entite unique, immobile a `(x, y)`. */
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  const K = STEERING_RECOMPUTE_TICKS;

  /** Le premier tick de recalcul de l'entite 0 strictement APRES `apres`. */
  function prochainRecalcul(horde: Horde, apres: number): number {
    const phase = horde.entityIdAt(0) % K;
    let tick = phase;
    while (tick <= apres) {
      tick += K;
    }
    return tick;
  }

  it('inverse exactement la vitesse calculee, dans les DEUX ordres (Chaux OU Vif-argent declenche)', () => {
    const fields = fieldsTowards(5000, 1000);
    const temoinPhase = une(1000, 1000);
    const tick = prochainRecalcul(temoinPhase, 0);

    for (const kind of [
      packZoneKind(ELEMENT.CHAUX, REACTION.AVEUGLEMENT),
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
    ]) {
      const fuyante = une(1000, 1000);
      const temoin = une(1000, 1000);
      const zones = new ZoneField();
      zones.spawn(kind, 1000, 1000, 0, 0);

      fuyante.step(DT, fields, tick, zones);
      temoin.step(DT, fields, tick);

      expect(temoin.vx[0]).not.toBe(0);
      expect(fuyante.vx[0]).toBe(-(temoin.vx[0] ?? 0));
      expect(fuyante.vy[0]).toBe(-(temoin.vy[0] ?? 0));
    }
  });

  it('une entite HORS de la zone n est pas affectee, a un pixel du bord', () => {
    const fields = fieldsTowards(5000, 1000);
    const horde = une(1000 + ZONE_RADIUS + 1, 1000);
    const temoin = une(1000 + ZONE_RADIUS + 1, 1000);
    const tick = prochainRecalcul(horde, 0);
    const zones = new ZoneField();
    zones.spawn(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT), 1000, 1000, 0, 0);

    horde.step(DT, fields, tick, zones);
    temoin.step(DT, fields, tick);

    expect(horde.vx[0]).toBe(temoin.vx[0]);
    expect(horde.vy[0]).toBe(temoin.vy[0]);
  });

  it('ne s applique PAS au tick de la pose, s applique au suivant — meme `slowsAt` que la Chaux seule', () => {
    const fields = fieldsTowards(5000, 1000);

    const auTick = une(1000, 1000);
    const tickAuTick = prochainRecalcul(auTick, 0);
    const zonesAuTick = new ZoneField();
    zonesAuTick.spawn(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
      1000,
      1000,
      0,
      tickAuTick,
    );
    auTick.step(DT, fields, tickAuTick, zonesAuTick);
    const temoinAuTick = une(1000, 1000);
    temoinAuTick.step(DT, fields, tickAuTick);
    expect(auTick.vx[0]).toBe(temoinAuTick.vx[0]);
    expect(auTick.vy[0]).toBe(temoinAuTick.vy[0]);

    const auPrecedent = une(1000, 1000);
    const tickAuPrecedent = prochainRecalcul(auPrecedent, 0);
    const zonesAuPrecedent = new ZoneField();
    zonesAuPrecedent.spawn(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
      1000,
      1000,
      0,
      tickAuPrecedent - 1,
    );
    auPrecedent.step(DT, fields, tickAuPrecedent, zonesAuPrecedent);
    const temoinAuPrecedent = une(1000, 1000);
    temoinAuPrecedent.step(DT, fields, tickAuPrecedent);
    expect(auPrecedent.vx[0]).toBe(-(temoinAuPrecedent.vx[0] ?? 0));
    expect(auPrecedent.vy[0]).toBe(-(temoinAuPrecedent.vy[0] ?? 0));
  });

  /**
   * ⚠️ **LE test qui assene LA DUREE, pas seulement l effet — §5 de la
   * spec : « plus forte ou plus longue que la Chaux seule ».**
   * `zoneFieldSign` n'a que deux valeurs (+1/-1) : rien n'est « plus fort »
   * que -1, donc si les deux ne se separaient que par « ca fuit », Aveuglement
   * serait du CONTENU MORT a cote de la Chaux seule. La separation reelle est
   * `zoneLifetimeTicks` : une Chaux seule (sans reaction nommee) fuit
   * pendant la duree GENERIQUE (90 ticks), Aveuglement continue jusqu'a
   * `SURCHAUFFE_ZONE_LIFETIME_TICKS` (135 ticks, reutilisee). Le tick de
   * mesure tombe entre les deux : la Chaux seule a deja lache prise,
   * Aveuglement fuit encore.
   */
  it('continue de fuir au dela de la duree d une Chaux seule : la DUREE les separe, pas l intensite', () => {
    const fields = fieldsTowards(5000, 1000);
    const temoinPhase = une(1000, 1000);
    const tick = prochainRecalcul(temoinPhase, ZONE_LIFETIME_TICKS);
    expect(tick).toBeLessThan(SURCHAUFFE_ZONE_LIFETIME_TICKS);

    const chauxSeule = new ZoneField();
    chauxSeule.spawn(ELEMENT.CHAUX, 1000, 1000, 0, 0);
    const aveuglement = new ZoneField();
    aveuglement.spawn(packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT), 1000, 1000, 0, 0);

    const avecChauxSeule = une(1000, 1000);
    const avecAveuglement = une(1000, 1000);
    const temoin = une(1000, 1000);

    avecChauxSeule.step(DT, fields, tick, chauxSeule);
    avecAveuglement.step(DT, fields, tick, aveuglement);
    temoin.step(DT, fields, tick);

    expect(temoin.vx[0]).not.toBe(0);
    // La Chaux seule a expire a ce tick : la vitesse rejoint celle du
    // temoin, plus aucune fuite.
    expect(avecChauxSeule.vx[0]).toBe(temoin.vx[0]);
    expect(avecChauxSeule.vy[0]).toBe(temoin.vy[0]);
    // Aveuglement fuit encore, au MEME instant, a la MEME geometrie.
    expect(avecAveuglement.vx[0]).toBe(-(temoin.vx[0] ?? 0));
    expect(avecAveuglement.vy[0]).toBe(-(temoin.vy[0] ?? 0));
  });
});

/**
 * Point de revue n°4 du plan de l'etape 5c, applique aux DEUX reactions de
 * cette tache qui combinent gel et fuite au meme point : Aveuglement (la
 * fuite) et Gel profond (le gel). `#computeSlow` prend le MINIMUM : `0`
 * (Gel profond) gagne sur `1` (aucun ralentissement propre d'Aveuglement),
 * donc l'entite est GELEE — la fuite qu'impose `#fieldSign` devient sans
 * objet, `#advanceByVelocity` multipliant `vx`/`vy` par `#slow` (0) APRES
 * que `#recomputeSteering` a deja fige leur DIRECTION. Meme raisonnement,
 * exactement, que Chaux+Supraconduction plus haut — ici avec les DEUX
 * reactions livrees par cette tache plutot qu'un element et une reaction
 * d'une tache anterieure.
 */
describe('Horde.step — un ennemi sous Aveuglement ET Gel profond est GELE, pas en fuite (point de revue n°4)', () => {
  function une(x: number, y: number): Horde {
    const horde = new Horde(10);
    horde.spawn(order({ count: 1, anchorX: x, anchorY: y, formation: FORMATION.SCATTER }));
    horde.x[0] = x;
    horde.y[0] = y;
    return horde;
  }

  function pasAu(horde: Horde, fields: FlowField[], tick: number, zones: ZoneField): number {
    for (let t = 0; t < tick; t++) {
      horde.step(DT, fields, t, zones);
    }
    const x0 = horde.x[0] ?? 0;
    const y0 = horde.y[0] ?? 0;
    horde.step(DT, fields, tick, zones);
    return Math.hypot((horde.x[0] ?? 0) - x0, (horde.y[0] ?? 0) - y0);
  }

  const MESURE = STEERING_RECOMPUTE_TICKS + 2;

  it('le gel de Gel profond gagne sur la fuite d Aveuglement : deplacement NUL, dans les deux ordres de POSE', () => {
    const fields = fieldsTowards(5000, 1000);

    const aveuglementPuisGel = new ZoneField();
    aveuglementPuisGel.spawn(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
      1000,
      1000,
      0,
      0,
    );
    aveuglementPuisGel.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, 0);

    const gelPuisAveuglement = new ZoneField();
    gelPuisAveuglement.spawn(packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND), 1000, 1000, 0, 0);
    gelPuisAveuglement.spawn(
      packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT),
      1000,
      1000,
      0,
      0,
    );

    expect(pasAu(une(1000, 1000), fields, MESURE, aveuglementPuisGel)).toBe(0);
    expect(pasAu(une(1000, 1000), fields, MESURE, gelPuisAveuglement)).toBe(0);
  });
});

describe('la charge du boss REMPLACE le deplacement (etape 6a, tache 5 bis)', () => {
  /**
   * Une horde d'une seule entite, en (1000, 1000), avec une vitesse tenue
   * franche vers l'est : le champ vise (5000, 1000), donc sans charge elle
   * avance toute seule a chaque pas. C'est ce qui rend le test porteur — une
   * position figee prouverait le remplacement seulement si quelque chose
   * poussait vraiment dans l'autre sens.
   */
  function bossSeul(): { horde: Horde; fields: FlowField[]; id: number } {
    const fields = fieldsTowards(5000, 1000);
    const horde = new Horde(100);
    horde.spawn(order({ count: 1, anchorX: 1000, anchorY: 1000 }), fields[0]);
    return { horde, fields, id: horde.entityIdAt(0) };
  }

  it('avance de lui-meme sans charge — le decor prouve qu il y a bien quelque chose a remplacer', () => {
    const { horde, fields } = bossSeul();
    const x0 = horde.x[0] ?? 0;
    for (let t = 1; t <= 20; t++) {
      horde.step(DT, fields, t);
    }
    expect((horde.x[0] ?? 0) - x0).toBeGreaterThan(20);
  });

  /**
   * ⚠️ **LE test de la tache.** Le boss est DANS la horde, et `Horde.step`
   * avance toutes les entites : si la charge s'AJOUTAIT au lieu de REMPLACER, il
   * avancerait deux fois. La position doit valoir exactement celle que
   * `chargePointAt` derive, au bit pres apres passage en `Float32Array` — pas
   * « a peu pres ».
   */
  it('pose exactement la position derivee, a chaque tick de la charge', () => {
    const { horde, fields, id } = bossSeul();
    const charge = makeBossCharge(id, horde.x[0] ?? 0, horde.y[0] ?? 0, 3000, 4000, 0);
    const attendu = new Float32Array(2);

    for (let t = 1; t <= charge.endTick + 2; t++) {
      horde.step(DT, fields, t, undefined, charge);
      if (!chargeHoldsAt(charge, t)) {
        continue;
      }
      chargePointAt(charge, t, attendu);
      expect(horde.x[0], `tick ${t}`).toBe(Math.fround(attendu[0] ?? 0));
      expect(horde.y[0], `tick ${t}`).toBe(Math.fround(attendu[1] ?? 0));
    }
  });

  /**
   * ⚠️ **La separation ne doit pas le pousser pendant qu'il charge.** C'est le
   * second piege annonce par le plan : `#applyDeoverlap` s'applique a TOUTES les
   * entites, arretees comprises. Ici cinquante voisines naissent sur lui —
   * chevauchement maximal, correction maximale — et la position derivee doit
   * quand meme etre exacte.
   */
  it('reste sur son couloir au pixel pres malgre cinquante voisines empilees dessus', () => {
    const fields = fieldsTowards(5000, 1000);
    const horde = new Horde(200);
    // ⚠️ **Le boss porte l'identite la PLUS GRANDE** (vague 9 contre vague 6),
    // et ce n'est pas cosmetique : `#applyDeoverlap` ne fait accumuler une
    // correction qu'a l'entite DERRIERE, departagee a distance egale par le
    // plus grand identifiant (`#isBehind`). Avec une identite plus petite que
    // celle de ses voisines, le boss n'encaisse rien du tout — et la mutation
    // « la charge s'applique avant la separation » survivait, appliquee sur le
    // disque, malgre cinquante voisines collees sur lui.
    horde.spawn(order({ waveId: 9, count: 1, anchorX: 1000, anchorY: 1000 }), fields[0]);
    const id = horde.entityIdAt(0);
    horde.spawn(
      order({ waveId: 6, count: 50, formation: FORMATION.CLUSTER, anchorX: 1000, anchorY: 1000 }),
      fields[0],
    );
    const charge = makeBossCharge(id, horde.x[0] ?? 0, horde.y[0] ?? 0, 1000, 5000, 0);
    const attendu = new Float32Array(2);

    // ⚠️ **Les voisines sont POSEES SUR le boss a chaque tick, pas seulement
    // nees a la meme ancre.** Deux vagues au meme point ne se chevauchent pas
    // pour autant — `formationPositions` les disperse — et sans chevauchement
    // reel, `#applyDeoverlap` n'exerce aucune correction : la mutation
    // « la charge s'applique AVANT l'avancement et la separation » survivait
    // alors, appliquee sur le disque, a la totalite de cette suite. C'est la
    // « fixture qui masque », dixieme occurrence de ce depot. Les reposer a
    // chaque tick est ce qui garantit une correction maximale a tous les ticks.
    for (let t = 1; t <= charge.endTick; t++) {
      const slotBoss = horde.slotOf(id);
      for (let i = 0; i < horde.count; i++) {
        if (i === slotBoss) {
          continue;
        }
        // ⚠️ **Toutes du MEME cote**, jamais reparties autour de lui : des
        // voisines symetriques produisent des poussees qui s'annulent, et une
        // correction nulle ne distingue plus « la separation ne le touche pas »
        // de « la separation le touche mais s'equilibre ».
        horde.x[i] = (horde.x[slotBoss] ?? 0) + 3 + (i % 4);
        horde.y[i] = (horde.y[slotBoss] ?? 0) + 3 + (i % 6);
      }
      horde.step(DT, fields, t, undefined, charge);
      chargePointAt(charge, t, attendu);
      const slot = horde.slotOf(id);
      expect(horde.x[slot], `tick ${t}`).toBe(Math.fround(attendu[0] ?? 0));
      expect(horde.y[slot], `tick ${t}`).toBe(Math.fround(attendu[1] ?? 0));
    }
  });

  /**
   * ⚠️ **`stopped` est pose pour le CLIP, pas pour le deplacement.**
   * `selectClip` (front) bascule sur l'animation d'attaque quand une entite est
   * marquee arretee, et ce sont ses six images qui montrent la rotation : rien
   * ne fait tourner le sprite en code. Le test porte donc sur ce booleen, pas
   * sur une position — les deux effets sont distincts et se testent
   * separement.
   */
  it('marque le boss arrete pendant toute la charge, pour qu il joue son clip d attaque', () => {
    const { horde, fields, id } = bossSeul();
    const charge = makeBossCharge(id, horde.x[0] ?? 0, horde.y[0] ?? 0, 5000, 1000, 0);

    horde.step(DT, fields, charge.windupTick + 1, undefined, charge);
    expect(horde.stopped[0]).toBe(1);
    horde.step(DT, fields, charge.startTick + 5, undefined, charge);
    expect(horde.stopped[0]).toBe(1);
    // Apres la charge, il redevient une entite ordinaire : `retarget` seul
    // decide alors s'il est au contact.
    horde.retarget([5000], [5000]);
    horde.step(DT, fields, charge.endTick + 1, undefined, charge);
    expect(horde.stopped[0]).toBe(0);
    expect(horde.slotOf(id)).toBe(0);
  });

  it('ne touche a personne d autre que l entite qui charge', () => {
    const fields = fieldsTowards(5000, 1000);
    const horde = new Horde(100);
    horde.spawn(order({ count: 10, anchorX: 1000, anchorY: 1000 }), fields[0]);
    const temoin = new Horde(100);
    temoin.spawn(order({ count: 10, anchorX: 1000, anchorY: 1000 }), fields[0]);
    const charge = makeBossCharge(horde.entityIdAt(0), 1000, 1000, 1000, 5000, 0);

    for (let t = 1; t <= charge.endTick; t++) {
      horde.step(DT, fields, t, undefined, charge);
      temoin.step(DT, fields, t);
    }

    for (let i = 1; i < 10; i++) {
      expect(horde.x[i], `entite ${i}`).toBe(temoin.x[i]);
      expect(horde.y[i], `entite ${i}`).toBe(temoin.y[i]);
    }
    expect(horde.x[0]).not.toBe(temoin.x[0]);
  });

  /**
   * ⚠️ **`dt <= 0` reste un NO-OP STRICT, charge comprise.** Le serveur ne fait
   * pas avancer sa horde pendant le gel de niveau (`Room.step` revient avant) ;
   * le client, lui, appelle `step` avec `dt * 0`. Deriver la position hors du
   * garde ferait avancer le boss chez le client pendant que le serveur le laisse
   * sur place — une divergence silencieuse, exactement ce que le scenario 9 de
   * la replication existe pour attraper.
   */
  it('ne bouge pas le boss quand dt est nul, meme en pleine charge', () => {
    const { horde, fields, id } = bossSeul();
    const charge = makeBossCharge(id, 4000, 4000, 4000, 5000, 0);

    horde.step(0, fields, charge.startTick + 5, undefined, charge);

    expect(horde.x[0]).not.toBe(4000);
    expect(horde.stopped[0]).toBe(0);
  });

  it('ignore une charge dont l entite n est plus dans la horde', () => {
    const { horde, fields, id } = bossSeul();
    const charge = makeBossCharge(id + 1000, 4000, 4000, 4000, 5000, 0);
    const avant = horde.x[0] ?? 0;

    horde.step(DT, fields, charge.startTick + 5, undefined, charge);

    expect(horde.x[0]).not.toBe(4000);
    expect(horde.x[0]).not.toBe(avant);
  });

  it('borne la position derivee a la carte, comme l avancement par vitesse', () => {
    const { horde, fields, id } = bossSeul();
    // Un couloir qui sort largement de la carte : le boss doit s'arreter au
    // bord, pas disparaitre dans les coordonnees negatives.
    const charge = makeBossCharge(id, 100, 100, 100, -5000, 0);

    for (let t = 1; t <= charge.endTick; t++) {
      horde.step(DT, fields, t, undefined, charge);
    }

    expect(horde.y[0]).toBe(0);
  });

  it('applique aussi la charge aux pas rattrapes par spawnCatchingUp', () => {
    const fields = fieldsTowards(5000, 1000);
    const avecCharge = new Horde(100);
    const sansCharge = new Horde(100);
    const o = order({ count: 1, anchorX: 1000, anchorY: 1000, spawnTick: 1 });
    // L'identite que `spawn` donnera a l'unique entite de cette vague.
    const id = entityIdOf(o.waveId, 0);
    const charge = makeBossCharge(id, 2000, 2000, 2000, 5000, 0);

    avecCharge.spawnCatchingUp(o, 6, DT, fields, undefined, charge);
    sansCharge.spawnCatchingUp(o, 6, DT, fields);

    const attendu = new Float32Array(2);
    chargePointAt(charge, o.spawnTick + 5, attendu);
    expect(avecCharge.x[0]).toBe(Math.fround(attendu[0] ?? 0));
    expect(sansCharge.x[0]).not.toBe(avecCharge.x[0]);
  });
});
