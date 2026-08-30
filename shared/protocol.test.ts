import { describe, expect, it } from 'vitest';

import { PLAYER_MAX_HP, SYNERGY_MAX, ZONE_LIFETIME_TICKS } from './constants';
import { ELEMENT, ELEMENTS } from './elements';
import {
  DEATH_ID_BYTES,
  DEATHS_HEADER_BYTES,
  DRAFT_CARD_BYTES,
  DRAFT_INTENT_BYTES,
  DRAFT_INTENTS_HEADER_BYTES,
  DRAFT_OPEN_HEADER_BYTES,
  DRAFT_OUTCOME_BYTES,
  DRAFT_RESULT_HEADER_BYTES,
  DRAFT_TOKEN_BYTES,
  decode,
  decodeDeaths,
  decodeInput,
  decodeLevelUp,
  decodePickups,
  decodeReaction,
  decodeRunOver,
  decodeSnapshot,
  decodeWaveOrder,
  decodeWelcome,
  decodeZone,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeDraftToken,
  encodeInput,
  encodeLevelUp,
  encodePickups,
  encodeReaction,
  encodeRunOver,
  encodeSnapshot,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  INPUT_BYTES,
  LEVEL_UP_BYTES,
  MSG,
  NO_TOKEN,
  packElementPair,
  REACTION_BYTES,
  RUN_OVER_BYTES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  unpackElementPair,
  ZONE_BYTES,
} from './protocol';

describe('encodeInput / decodeInput', () => {
  it("rend exactement l'entree encodee, visee comprise (tache 13)", () => {
    const decoded = decodeInput(encodeInput(1234, -100, 27, 90, -60));

    expect(decoded).toEqual({
      type: MSG.INPUT,
      seq: 1234,
      moveX: -100,
      moveY: 27,
      aimX: 90,
      aimY: -60,
    });
  });

  it('borne le deplacement ET la visee a -127..127 au lieu de deborder sur un octet signe', () => {
    const decoded = decodeInput(encodeInput(0, 500, -500, 500, -500));

    expect(decoded.moveX).toBe(127);
    expect(decoded.moveY).toBe(-127);
    expect(decoded.aimX).toBe(127);
    expect(decoded.aimY).toBe(-127);
  });

  it('fait le tour du compteur de sequence sur 16 bits', () => {
    expect(decodeInput(encodeInput(65535, 0, 0, 0, 0)).seq).toBe(65535);
  });

  // ⚠️ Ce test ne pourrait PAS attraper un decalage d'octet entre aimX et
  // aimY (un aller-retour seul ne le peut jamais, encodeur et decodeur
  // partageant la meme erreur) : c'est la raison d'etre du test de taille
  // exacte ci-dessous, et de celui de troncature plus bas, qui portent sur
  // le format lui-meme plutot que sur le seul aller-retour.
  it('tient exactement INPUT_BYTES octets (5 -> 7, tache 13 : +aimX +aimY)', () => {
    expect(encodeInput(1, 1, 1, 1, 1).byteLength).toBe(INPUT_BYTES);
    expect(INPUT_BYTES).toBe(7);
  });

  it('leve sur un buffer tronque plutot que de rendre une entree fantaisiste', () => {
    const truncated = encodeInput(1, 1, 1, 1, 1).slice(0, 3);

    expect(() => decodeInput(truncated)).toThrow(/tronqu/i);
  });

  // ⚠️ Distinct du test de troncature generique ci-dessus : celui-ci coupe
  // PILE avant les deux octets de visee ajoutes par la tache 13 (l'entree
  // faisait 5 octets avant elle). Sans cette coupe precise, un decalage qui
  // ecrirait aimX/aimY hors de INPUT_BYTES pourrait passer inapercu tant que
  // le buffer alloue est assez grand pour absorber l'erreur.
  it('leve sur un buffer tronque juste avant la visee (5 octets, tache 13)', () => {
    const truncated = encodeInput(1, 1, 1, 90, -60).slice(0, 5);

    expect(() => decodeInput(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodeSnapshot / decodeSnapshot', () => {
  // ⚠️ Toutes les valeurs de l'en-tete sont DISTINCTES — tick 42, xp 12 000,
  // synergie 7 — parce qu'un aller-retour ne voit pas un decalage qui echange
  // deux champs de meme valeur. C'est la seule facon d'assener que la Synergie
  // ne s'ecrit pas par-dessus l'experience.
  it('rend les positions arrondies a l entier, les pv personnels, la visee, l experience et la synergie d equipe', () => {
    const buf = encodeSnapshot(42, 12_000, 7, [
      { id: 1, x: 100.4, y: 200.6, hp: 80, aimX: 90, aimY: -60 },
      { id: 2, x: -3.2, y: 5999.9, hp: 42, aimX: 0, aimY: 0 },
    ]);

    expect(decodeSnapshot(buf)).toEqual({
      type: MSG.SNAPSHOT,
      tick: 42,
      xp: 12_000,
      synergy: 7,
      players: [
        { id: 1, x: 100, y: 201, hp: 80, aimX: 90, aimY: -60 },
        { id: 2, x: -3, y: 6000, hp: 42, aimX: 0, aimY: 0 },
      ],
    });
  });

  it('encode un salon vide sans joueur', () => {
    expect(decodeSnapshot(encodeSnapshot(0, 0, 0, [])).players).toEqual([]);
  });

  it('tient un numero de tick sur 32 bits', () => {
    expect(decodeSnapshot(encodeSnapshot(4_294_967_295, 0, 0, [])).tick).toBe(4_294_967_295);
  });

  // Les deux tailles sont assenees EN CHIFFRES NUS, jamais comparees a
  // elles-memes : c'est ce qui attrape un decalage d'octet. Une assertion
  // `toBe(SNAPSHOT_HEADER_BYTES)` serait vraie quoi qu'il arrive.
  it('tient exactement SNAPSHOT_HEADER_BYTES + n * SNAPSHOT_PLAYER_BYTES octets (8 -> 10 avec la synergie)', () => {
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0 },
      { id: 3, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0 },
    ]);

    expect(buf.byteLength).toBe(SNAPSHOT_HEADER_BYTES + 3 * SNAPSHOT_PLAYER_BYTES);
    expect(SNAPSHOT_HEADER_BYTES).toBe(10);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(9);
  });

  it('tient les pv personnels sur un octet (u8, borne 255)', () => {
    const buf = encodeSnapshot(1, 0, 0, [{ id: 1, x: 0, y: 0, hp: 255, aimX: 0, aimY: 0 }]);

    expect(decodeSnapshot(buf).players[0]).toEqual({
      id: 1,
      x: 0,
      y: 0,
      hp: 255,
      aimX: 0,
      aimY: 0,
    });
  });

  it('borne la visee redistribuee a -127..127, comme celle d un INPUT (tache 13)', () => {
    const buf = encodeSnapshot(1, 0, 0, [{ id: 1, x: 0, y: 0, hp: 1, aimX: 500, aimY: -500 }]);

    expect(decodeSnapshot(buf).players[0]).toMatchObject({ aimX: 127, aimY: -127 });
  });

  it("tient l'experience d'equipe sur deux octets (u16, borne 65 535)", () => {
    const buf = encodeSnapshot(1, 65_535, 0, []);

    expect(decodeSnapshot(buf).xp).toBe(65_535);
  });

  it('tient la synergie d equipe sur deux octets (u16, borne 65 535)', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 65_535, [])).synergy).toBe(65_535);
  });

  // ⚠️ La lecon de l'etape 4 : `hp` etait encode sur un octet, le passif
  // « vitalite » a pousse un joueur a 260 PV, et il se repliait en silence a
  // 4 PV au decodage. Un champ n'est pas assez large parce qu'il en a l'air :
  // on confronte la valeur que le JEU produit reellement a la largeur du
  // champ, sans jamais reecrire 20 en dur (le plafond est un reglage).
  it('SYNERGY_MAX tient dans le u16 du snapshot, sans repli silencieux', () => {
    expect(SYNERGY_MAX).toBeLessThanOrEqual(65_535);
    expect(decodeSnapshot(encodeSnapshot(1, 0, SYNERGY_MAX, [])).synergy).toBe(SYNERGY_MAX);
  });

  it('PLAYER_MAX_HP tient dans un octet (u8)', () => {
    expect(PLAYER_MAX_HP).toBeLessThanOrEqual(255);
  });

  // ⚠️ Coupe PILE avant les deux octets de synergie (en-tete de 10 : les 8
  // premiers passent, la synergie manque). Sans lui, un en-tete qui
  // n'exigerait que ses 8 octets d'avant rendrait une synergie fantaisiste au
  // lieu de lever.
  it('leve sur un en-tete tronque juste avant la synergie d equipe', () => {
    const truncated = encodeSnapshot(1, 12_000, 7, []).slice(0, SNAPSHOT_HEADER_BYTES - 2);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });

  it("leve quand l'en-tete annonce plus de joueurs que le buffer n'en contient", () => {
    const truncated = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0 },
    ]).slice(0, SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });

  // ⚠️ Coupe PILE avant les deux octets de visee du premier joueur (bloc de
  // 8 octets, tache 13 : les 6 premiers passent, aimX/aimY manquent). Sans ce
  // test precis, un decalage qui placerait aimX/aimY hors du bloc pourrait
  // passer inapercu tant que le buffer alloue reste assez grand.
  it('leve sur un buffer tronque juste avant la visee du joueur (tache 13)', () => {
    const truncated = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 90, aimY: -60 },
    ]).slice(0, SNAPSHOT_HEADER_BYTES + 6);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodeDeaths / decodeDeaths', () => {
  it("rend le tick et les identites, triees dans l'ordre canonique", () => {
    const decoded = decodeDeaths(encodeDeaths(7, [42, 3, 17]));

    expect(decoded).toEqual({ type: MSG.DEATHS, tick: 7, ids: [3, 17, 42] });
  });

  it('tient exactement DEATHS_HEADER_BYTES + n * DEATH_ID_BYTES octets', () => {
    const buf = encodeDeaths(1, [1, 2, 3]);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES + 3 * DEATH_ID_BYTES);
    expect(DEATHS_HEADER_BYTES).toBe(7);
    expect(DEATH_ID_BYTES).toBe(4);
  });

  it('encode un lot vide sans identite morte', () => {
    const buf = encodeDeaths(1, []);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES);
    expect(decodeDeaths(buf).ids).toEqual([]);
  });

  it('tient un compte sur 16 bits, jusqu a 65 535 identites', () => {
    const ids = Array.from({ length: 65_535 }, (_, i) => i);
    const buf = encodeDeaths(1, ids);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES + 65_535 * DEATH_ID_BYTES);
    expect(decodeDeaths(buf).ids).toHaveLength(65_535);
  });

  it('ne grossit pas avec le nombre d entites vivantes, seulement avec les morts', () => {
    const dix = encodeDeaths(1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const une = encodeDeaths(1, [1]);

    expect(dix.byteLength - une.byteLength).toBe(9 * 4);
  });

  it('leve sur un buffer tronque plutot que de rendre des identites fantaisistes', () => {
    const truncated = encodeDeaths(1, [1, 2, 3]).slice(0, DEATHS_HEADER_BYTES + 2);

    expect(() => decodeDeaths(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodePickups / decodePickups', () => {
  it("rend le tick et les identites, triees dans l'ordre canonique", () => {
    const decoded = decodePickups(encodePickups(9, [30, 10, 20]));

    expect(decoded).toEqual({ type: MSG.PICKUPS, tick: 9, ids: [10, 20, 30] });
  });

  it('tient exactement DEATHS_HEADER_BYTES + n * DEATH_ID_BYTES octets, comme DEATHS', () => {
    const buf = encodePickups(1, [1, 2, 3]);

    expect(buf.byteLength).toBe(DEATHS_HEADER_BYTES + 3 * DEATH_ID_BYTES);
  });

  it('encode un lot vide sans ramassage', () => {
    expect(decodePickups(encodePickups(1, [])).ids).toEqual([]);
  });

  it('leve sur un buffer tronque', () => {
    const truncated = encodePickups(1, [1, 2, 3]).slice(0, DEATHS_HEADER_BYTES + 2);

    expect(() => decodePickups(truncated)).toThrow(/tronqu/i);
  });

  it("ne se confond jamais avec DEATHS bien que l'encodage soit factorise", () => {
    const deaths = encodeDeaths(5, [1, 2]);
    const pickups = encodePickups(5, [1, 2]);

    expect(new DataView(deaths).getUint8(0)).toBe(MSG.DEATHS);
    expect(new DataView(pickups).getUint8(0)).toBe(MSG.PICKUPS);
    expect(decode(pickups).type).toBe(MSG.PICKUPS);
    expect(decode(deaths).type).toBe(MSG.DEATHS);
  });
});

describe('encodeLevelUp / decodeLevelUp', () => {
  it("rend le tick de gel et le niveau atteint par l'equipe, sans identifiant de joueur", () => {
    const decoded = decodeLevelUp(encodeLevelUp(1234, 7));

    expect(decoded).toEqual({ type: MSG.LEVEL_UP, tick: 1234, level: 7 });
    expect(decoded).not.toHaveProperty('playerId');
  });

  it('tient exactement LEVEL_UP_BYTES octets', () => {
    expect(encodeLevelUp(1, 1).byteLength).toBe(LEVEL_UP_BYTES);
    expect(LEVEL_UP_BYTES).toBe(6);
  });

  it('tient le niveau sur un octet (u8), jusqu a 255', () => {
    expect(decodeLevelUp(encodeLevelUp(1, 255)).level).toBe(255);
  });

  it('leve sur un buffer tronque plutot que de rendre un gel fantaisiste', () => {
    const truncated = encodeLevelUp(1, 1).slice(0, LEVEL_UP_BYTES - 1);

    expect(() => decodeLevelUp(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodeRunOver / decodeRunOver', () => {
  it('rend le temps survecu, le niveau et le nombre d ennemis tues', () => {
    const decoded = decodeRunOver(encodeRunOver(9000, 500_000, 12, 100_000));

    expect(decoded).toEqual({
      type: MSG.RUN_OVER,
      tick: 9000,
      survivedTicks: 500_000,
      level: 12,
      kills: 100_000,
    });
  });

  it('tient exactement RUN_OVER_BYTES octets', () => {
    expect(encodeRunOver(1, 1, 1, 1).byteLength).toBe(RUN_OVER_BYTES);
    expect(RUN_OVER_BYTES).toBe(14);
  });

  it('tient les tues sur 32 bits, pas 16 : une run longue depasse 65 535 ennemis', () => {
    const decoded = decodeRunOver(encodeRunOver(1, 1, 1, 100_000));

    expect(decoded.kills).toBe(100_000);
  });

  it('leve sur un buffer tronque plutot que de rendre un resultat fantaisiste', () => {
    const truncated = encodeRunOver(1, 1, 1, 1).slice(0, RUN_OVER_BYTES - 1);

    expect(() => decodeRunOver(truncated)).toThrow(/tronqu/i);
  });
});

describe('encodeWelcome / decodeWelcome', () => {
  it("rend l'identifiant attribue, le tick courant et la graine de carte", () => {
    expect(decodeWelcome(encodeWelcome(3, 900, 0xdead_beef))).toEqual({
      type: MSG.WELCOME,
      playerId: 3,
      tick: 900,
      mapSeed: 0xdead_beef,
    });
  });
});

describe('encodeWaveOrder / decodeWaveOrder', () => {
  const order = {
    waveId: 7,
    spawnTick: 1234,
    seed: 0x1234_5678,
    archetype: 2,
    formation: 3,
    anchorX: -1200,
    anchorY: 5900,
    count: 1000,
  };

  it("rend exactement l'ordre encode", () => {
    expect(decodeWaveOrder(encodeWaveOrder(order))).toEqual({
      type: MSG.WAVE_ORDER,
      ...order,
    });
  });

  it('tient en 19 octets : 1 de type et 18 de charge utile', () => {
    expect(encodeWaveOrder(order).byteLength).toBe(19);
  });

  it('ne grossit pas avec le nombre d entites — c est tout le sujet du §3.3', () => {
    const petite = encodeWaveOrder({ ...order, count: 10 });
    const enorme = encodeWaveOrder({ ...order, count: 4000 });

    expect(enorme.byteLength).toBe(petite.byteLength);
  });

  it('leve sur un buffer tronque', () => {
    const tronque = encodeWaveOrder(order).slice(0, 12);

    expect(() => decodeWaveOrder(tronque)).toThrow(/tronqu/i);
  });
});

describe('decode', () => {
  it('aiguille sur le premier octet', () => {
    expect(decode(encodeInput(7, 1, 0, 0, 0))).toMatchObject({ type: MSG.INPUT, seq: 7 });
    expect(decode(encodeSnapshot(8, 0, 0, []))).toMatchObject({ type: MSG.SNAPSHOT, tick: 8 });
    expect(decode(encodeWelcome(1, 9, 0))).toMatchObject({ type: MSG.WELCOME, playerId: 1 });
  });

  it('aiguille aussi sur les morts et les ramassages', () => {
    expect(decode(encodeDeaths(1, [1, 2]))).toMatchObject({ type: MSG.DEATHS, tick: 1 });
    expect(decode(encodePickups(1, [1, 2]))).toMatchObject({ type: MSG.PICKUPS, tick: 1 });
  });

  it('aiguille aussi sur le niveau et la fin de run', () => {
    expect(decode(encodeLevelUp(1, 5))).toMatchObject({ type: MSG.LEVEL_UP, tick: 1 });
    expect(decode(encodeRunOver(1, 1, 1, 1))).toMatchObject({ type: MSG.RUN_OVER, tick: 1 });
  });

  it('aiguille aussi sur un ordre de vague', () => {
    const buf = encodeWaveOrder({
      waveId: 1,
      spawnTick: 2,
      seed: 3,
      archetype: 0,
      formation: 0,
      anchorX: 0,
      anchorY: 0,
      count: 5,
    });

    expect(decode(buf)).toMatchObject({ type: MSG.WAVE_ORDER, waveId: 1 });
  });

  // ⚠️ Les deux nouveaux types partagent la meme taille (11 octets) : sans
  // aiguillage sur le premier octet, une zone se decoderait en reaction sans
  // qu'aucune borne ne proteste. On assene donc un champ propre a chacun, pas
  // seulement le type.
  it('aiguille aussi sur une zone au sol et sur une reaction (etape 5a)', () => {
    expect(decode(encodeZone(ELEMENT.GIVRE, 10, 20, 30, 2))).toEqual({
      type: MSG.ZONE,
      element: ELEMENT.GIVRE,
      x: 10,
      y: 20,
      bornTick: 30,
      by: 2,
    });

    expect(
      decode(encodeReaction(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE), 40, 50, 60, true)),
    ).toEqual({
      type: MSG.REACTION,
      pair: packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE),
      x: 40,
      y: 50,
      tick: 60,
      synergyCharge: true,
    });
  });

  it('leve sur un type de message inconnu', () => {
    expect(() => decode(new Uint8Array([200]).buffer)).toThrow(/inconnu/i);
  });

  it('leve sur un buffer vide', () => {
    expect(() => decode(new ArrayBuffer(0))).toThrow(/tronqu/i);
  });
});

describe('DRAFT_OPEN', () => {
  // ⚠️ **Plus d'octet `owner`.** Il portait l'exclusivite des cartes reservees,
  // qui n'existe plus : toute carte est ouverte a tout le monde. Une carte
  // tient donc en DEUX octets, et c'est l'assertion de taille ci-dessous qui
  // le garde.
  //
  // Les trois cartes ne partagent ni nature ni `refId` : un encodeur qui
  // intervertirait les deux octets se verrait.
  const cartes = [
    { nature: 0, refId: 3 },
    { nature: 1, refId: 7 },
    { nature: 0, refId: 8 },
  ];

  it('fait un aller-retour exact', () => {
    const msg = decode(encodeDraftOpen(1234, cartes));
    expect(msg.type).toBe(MSG.DRAFT_OPEN);
    if (msg.type !== MSG.DRAFT_OPEN) {
      throw new Error('type inattendu');
    }
    expect(msg.deadlineTick).toBe(1234);
    expect(msg.cards).toEqual(cartes);
  });

  it('a la taille exacte annoncee par ses constantes', () => {
    // ⚠️ C'est cette assertion, et non l'aller-retour, qui attrape un decalage
    // d'octet : l'encodeur et le decodeur partagent la faute, donc ils se
    // comprennent meme quand ils ont tort.
    expect(encodeDraftOpen(1, cartes).byteLength).toBe(
      DRAFT_OPEN_HEADER_BYTES + cartes.length * DRAFT_CARD_BYTES,
    );
    expect(encodeDraftOpen(1, []).byteLength).toBe(DRAFT_OPEN_HEADER_BYTES);
    // ⚠️ La ligne ci-dessus se calcule AVEC la constante : elle passerait sur
    // une carte de trois octets si la constante mentait aussi. Le chiffre nu
    // est ce qui garde la disparition de l'octet `owner`.
    expect(DRAFT_CARD_BYTES).toBe(2);
    expect(encodeDraftOpen(1, cartes).byteLength).toBe(DRAFT_OPEN_HEADER_BYTES + 6);
  });

  it('leve sur un tampon tronque', () => {
    const buf = encodeDraftOpen(1, cartes);
    expect(() => decode(buf.slice(0, DRAFT_OPEN_HEADER_BYTES + 1))).toThrow(/tronque/);
  });
});

describe('DRAFT_TOKEN', () => {
  it('fait un aller-retour exact et a la taille annoncee', () => {
    const msg = decode(encodeDraftToken(5));
    expect(msg.type).toBe(MSG.DRAFT_TOKEN);
    if (msg.type !== MSG.DRAFT_TOKEN) {
      throw new Error('type inattendu');
    }
    expect(msg.cardIndex).toBe(5);
    expect(encodeDraftToken(5).byteLength).toBe(DRAFT_TOKEN_BYTES);
  });

  it('transporte la sentinelle « aucun jeton » sans la confondre avec la carte 0', () => {
    const aucun = decode(encodeDraftToken(NO_TOKEN));
    if (aucun.type !== MSG.DRAFT_TOKEN) {
      throw new Error('type inattendu');
    }
    expect(aucun.cardIndex).toBe(NO_TOKEN);
    expect(aucun.cardIndex).not.toBe(0);
  });
});

describe('DRAFT_INTENTS', () => {
  const intentions = [
    { playerId: 1, cardIndex: 4 },
    { playerId: 3, cardIndex: 0 },
  ];

  it('fait un aller-retour exact et a la taille annoncee', () => {
    const msg = decode(encodeDraftIntents(intentions));
    if (msg.type !== MSG.DRAFT_INTENTS) {
      throw new Error('type inattendu');
    }
    expect(msg.intents).toEqual(intentions);
    expect(encodeDraftIntents(intentions).byteLength).toBe(
      DRAFT_INTENTS_HEADER_BYTES + intentions.length * DRAFT_INTENT_BYTES,
    );
  });

  it('leve sur un tampon tronque', () => {
    const buf = encodeDraftIntents(intentions);
    expect(() => decode(buf.slice(0, DRAFT_INTENTS_HEADER_BYTES + 1))).toThrow(/tronque/);
  });
});

describe('DRAFT_RESULT', () => {
  const issues = [
    { playerId: 1, cardIndex: 2, outcome: 0 },
    { playerId: 2, cardIndex: 2, outcome: 1 },
    { playerId: 4, cardIndex: 6, outcome: 2 },
  ];

  it('fait un aller-retour exact et a la taille annoncee', () => {
    const msg = decode(encodeDraftResult(900, issues));
    if (msg.type !== MSG.DRAFT_RESULT) {
      throw new Error('type inattendu');
    }
    expect(msg.deadlineTick).toBe(900);
    expect(msg.outcomes).toEqual(issues);
    expect(encodeDraftResult(900, issues).byteLength).toBe(
      DRAFT_RESULT_HEADER_BYTES + issues.length * DRAFT_OUTCOME_BYTES,
    );
  });

  it('porte la fin du gel, que le client ne peut PAS deduire', () => {
    // ⚠️ **Il y avait un octet `phase` avant `deadlineTick`.** Il distinguait
    // « le draft est termine » de « une repioche s'ouvre » ; la repioche n'a
    // plus lieu, la resolution est un seul moment, et le message n'a plus
    // qu'un sens possible.
    //
    // Ce qui reste indispensable, c'est `deadlineTick` : la fenetre dure
    // jusqu'a ce que tout le monde ait pose son jeton, et en solo elle se
    // ferme au clic — chaque client devinerait une fin de gel differente. On
    // eprouve DEUX echeances distinctes : un champ code en dur passerait avec
    // une seule.
    for (const deadline of [700, 0x1234_5678]) {
      const msg = decode(encodeDraftResult(deadline, issues));
      if (msg.type !== MSG.DRAFT_RESULT) {
        throw new Error('type inattendu');
      }
      expect(msg.deadlineTick).toBe(deadline);
    }
  });

  it('tient sur SIX octets d en-tete : l octet de phase a disparu', () => {
    // La taille est le seul endroit ou la disparition de `phase` se constate
    // sans lire le code — et un en-tete de sept octets se decoderait sans
    // lever, en decalant simplement toutes les issues.
    expect(DRAFT_RESULT_HEADER_BYTES).toBe(6);
    expect(encodeDraftResult(900, []).byteLength).toBe(6);
  });

  it('leve un message TRONQUE explicite, pas une erreur de bornes fortuite', () => {
    // ⚠️ Assener seulement `toThrow()` ne prouve rien ici : sans le controle
    // de longueur, le `DataView` finit par lever tout seul en depassant. La
    // mutation « retirer le controle » survivait a un test moins precis.
    // C'est le MESSAGE qui rend ce controle porteur.
    const buf = encodeDraftResult(1, issues);
    expect(() => decode(buf.slice(0, DRAFT_RESULT_HEADER_BYTES + 1))).toThrow(/tronque/);
  });
});

describe('packElementPair / unpackElementPair', () => {
  it('rend le meme octet quel que soit l ordre des deux elements', () => {
    expect(packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE)).toBe(
      packElementPair(ELEMENT.GIVRE, ELEMENT.BRAISE),
    );
  });

  // ⚠️ La moitie qui manque toujours : « le meme octet » serait aussi vrai
  // d'une fonction qui rend une constante. Deux couples differents doivent
  // porter deux octets differents, sinon le client dessinerait le meme flash
  // pour deux reactions du §6.3.
  it('donne un octet different a chaque couple distinct', () => {
    const braiseGivre = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);
    const neutreGivre = packElementPair(ELEMENT.NEUTRE, ELEMENT.GIVRE);
    const neutreBraise = packElementPair(ELEMENT.NEUTRE, ELEMENT.BRAISE);

    expect(new Set([braiseGivre, neutreGivre, neutreBraise]).size).toBe(3);
  });

  it('rend les deux elements au depaquetage, du plus petit au plus grand', () => {
    expect(unpackElementPair(packElementPair(ELEMENT.GIVRE, ELEMENT.BRAISE))).toEqual([
      ELEMENT.BRAISE,
      ELEMENT.GIVRE,
    ]);
  });

  it('depaquette tous les couples du catalogue, sans confondre les deux quartets', () => {
    for (const a of ELEMENTS) {
      for (const b of ELEMENTS) {
        const [lo, hi] = unpackElementPair(packElementPair(a.id, b.id));

        expect(lo).toBe(Math.min(a.id, b.id));
        expect(hi).toBe(Math.max(a.id, b.id));
      }
    }
  });

  // Le couple tient sur UN octet parce que chaque element tient sur un
  // quartet. Six elements sont prevus au §6.3 de l'orientation, seize
  // rentrent : la marge est verifiee, pas supposee — un dix-septieme element
  // replierait les couples en silence, exactement comme `hp` sur un octet a
  // l'etape 4.
  it('garde la marge du quartet : au plus seize elements', () => {
    expect(ELEMENTS.length).toBeLessThanOrEqual(16);
  });
});

describe('encodeZone / decodeZone', () => {
  // Les six champs sont assenes, sur six valeurs TOUTES DISTINCTES : un
  // aller-retour qui n'en verifierait que deux passerait meme si les quatre
  // autres etaient ecrases, et deux champs de meme valeur masqueraient un
  // decalage d'octet qui les echange.
  it('rend exactement la zone encodee, ses six champs', () => {
    expect(decodeZone(encodeZone(ELEMENT.GIVRE, -1234, 5678, 90_001, 3))).toEqual({
      type: MSG.ZONE,
      element: ELEMENT.GIVRE,
      x: -1234,
      y: 5678,
      bornTick: 90_001,
      by: 3,
    });
  });

  it('tient exactement ZONE_BYTES octets, et ZONE_BYTES en fait 11', () => {
    expect(encodeZone(ELEMENT.BRAISE, 1, 1, 1, 1).byteLength).toBe(ZONE_BYTES);
    expect(ZONE_BYTES).toBe(11);
  });

  // ⚠️ Les deux valeurs sont choisies pour que l'ARRONDI et la TRONCATURE ne
  // donnent pas le meme resultat : `DataView.setInt16` tronque vers zero, donc
  // 100,4 passerait a 100 dans les deux cas et un `Math.round` retire ne se
  // verrait pas. 100,6 et -3,6 le voient.
  it('arrondit la position a l entier, comme le snapshot', () => {
    const decoded = decodeZone(encodeZone(ELEMENT.BRAISE, 100.6, -3.6, 0, 0));

    expect(decoded.x).toBe(101);
    expect(decoded.y).toBe(-4);
  });

  // ⚠️ `bornTick` porte la DATE DE PEREMPTION de la zone a lui tout seul : la
  // mort n'est jamais annoncee, les deux cotes la derivent de ce tick et de
  // `ZONE_LIFETIME_TICKS`. Un tick replie en silence ferait donc disparaitre
  // un quad au mauvais moment chez le client, sans qu'aucun message ne
  // contredise jamais l'erreur. Le compteur de ticks d'un salon est le meme
  // u32 que celui du snapshot : on le mene a sa borne.
  it('tient un tick de naissance sur 32 bits, jusqu a 4 294 967 295', () => {
    const born = 4_294_967_295 - ZONE_LIFETIME_TICKS;
    const decoded = decodeZone(encodeZone(ELEMENT.BRAISE, 0, 0, born, 0));

    expect(decoded.bornTick).toBe(born);
    expect(decodeZone(encodeZone(ELEMENT.BRAISE, 0, 0, 4_294_967_295, 0)).bornTick).toBe(
      4_294_967_295,
    );
  });

  it('leve un message TRONQUE explicite sur un tampon court, pas une erreur de bornes fortuite', () => {
    const truncated = encodeZone(ELEMENT.GIVRE, 1, 2, 3, 4).slice(0, ZONE_BYTES - 1);

    expect(() => decodeZone(truncated)).toThrow(/tronqu/);
  });

  it('ne grossit pas avec la duree de vie : aucune date de peremption sur le fil', () => {
    expect(encodeZone(ELEMENT.BRAISE, 0, 0, 0, 0).byteLength).toBe(
      encodeZone(ELEMENT.GIVRE, 0, 0, ZONE_LIFETIME_TICKS, 0).byteLength,
    );
  });
});

describe('encodeReaction / decodeReaction', () => {
  it('rend exactement la reaction encodee, ses cinq champs', () => {
    const pair = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);

    expect(decodeReaction(encodeReaction(pair, -300, 411, 77, true))).toEqual({
      type: MSG.REACTION,
      pair,
      x: -300,
      y: 411,
      tick: 77,
      synergyCharge: true,
    });
  });

  // ⚠️ **Les deux moities, toujours.** Un aller-retour qui ne verifie que la
  // charge passe avec un encodeur qui met 1 en dur — et la Synergie du §7,
  // « le coeur du projet », monterait alors a chaque reaction, solo comprise.
  it('rend une reaction SANS charge de synergie, celle d un joueur seul', () => {
    const pair = packElementPair(ELEMENT.BRAISE, ELEMENT.GIVRE);

    expect(decodeReaction(encodeReaction(pair, -300, 411, 77, false))).toEqual({
      type: MSG.REACTION,
      pair,
      x: -300,
      y: 411,
      tick: 77,
      synergyCharge: false,
    });
  });

  it('tient exactement REACTION_BYTES octets, et REACTION_BYTES en fait 11', () => {
    expect(encodeReaction(1, 1, 1, 1, true).byteLength).toBe(REACTION_BYTES);
    expect(REACTION_BYTES).toBe(11);
  });

  // La charge coute ZERO octet de plus : elle voyage dans ce message plutot
  // que dans un second (§8), et une reaction chargee pese donc exactement ce
  // que pese une reaction solo.
  it('ne coute pas un octet de plus quand elle charge la barre', () => {
    expect(encodeReaction(1, 0, 0, 0, true).byteLength).toBe(
      encodeReaction(1, 0, 0, 0, false).byteLength,
    );
  });

  // Memes valeurs discriminantes que pour la zone : -12,6 et 7,6 separent
  // l'arrondi de la troncature de `DataView`.
  it('arrondit la position a l entier', () => {
    const decoded = decodeReaction(encodeReaction(0, -12.6, 7.6, 0, false));

    expect(decoded.x).toBe(-13);
    expect(decoded.y).toBe(8);
  });

  it('tient un tick sur 32 bits', () => {
    expect(decodeReaction(encodeReaction(0, 0, 0, 4_294_967_295, false)).tick).toBe(4_294_967_295);
  });

  it('leve un message TRONQUE explicite sur un tampon court', () => {
    const truncated = encodeReaction(1, 2, 3, 4, true).slice(0, REACTION_BYTES - 1);

    expect(() => decodeReaction(truncated)).toThrow(/tronqu/);
  });
});
