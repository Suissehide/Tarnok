import { describe, expect, it } from 'vitest';

import { ABILITY_COOLDOWN_TICKS, VERB_IDS } from './abilities';
import { makeBossCharge } from './boss';
import {
  MAX_PER_WAVE,
  MAX_PLAYERS,
  PLAYER_MAX_HP,
  SYNERGY_MAX,
  ZONE_LIFETIME_TICKS,
} from './constants';
import { ELEMENT, ELEMENTS } from './elements';
import { entityIdOf } from './horde';
import { bossHp, palierGold } from './paliers';
import {
  ABILITY_BYTES,
  ABILITY_USED_BYTES,
  BOSS_CHARGE_BYTES,
  BOSS_HP_MAX,
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
  decodeAbility,
  decodeAbilityUsed,
  decodeBossCharge,
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
  EXTRACT_MULTIPLIER_MAX,
  encodeAbility,
  encodeAbilityUsed,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeDraftToken,
  encodeHello,
  encodeInput,
  encodeLevelUp,
  encodePickups,
  encodePing,
  encodePingShown,
  encodePortalOpen,
  encodePortalResult,
  encodeReaction,
  encodeRunOver,
  encodeSnapshot,
  encodeVote,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  GOLD_MAX,
  HELLO_BYTES,
  INPUT_BYTES,
  LEVEL_UP_BYTES,
  MSG,
  NO_BOSS_ID,
  NO_TOKEN,
  NO_VOTE,
  PING_BYTES,
  PING_SHOWN_BYTES,
  type PlayerSnapshot,
  PORTAL_OPEN_BYTES,
  PORTAL_RESULT_BYTES,
  packElementPair,
  packZoneKind,
  REACTION_BYTES,
  RUN_OVER_BYTES,
  SNAPSHOT_HEADER_BYTES,
  SNAPSHOT_PLAYER_BYTES,
  TOKEN_BYTES,
  unpackElementPair,
  VOTE_BYTES,
  VOTE_CHOICE,
  VOTE_ENTRY_BYTES,
  VOTES_HEADER_BYTES,
  ZONE_BYTES,
  zoneElement,
  zoneReaction,
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

  // ⚠️ Un aller-retour seul ne voit jamais un decalage d'octet entre aimX et
  // aimY (encodeur et decodeur partagent l'erreur) : c'est le role des tests
  // de taille exacte et de troncature, qui portent sur le format lui-meme.
  it('tient exactement INPUT_BYTES octets (5 -> 7, tache 13 : +aimX +aimY)', () => {
    expect(encodeInput(1, 1, 1, 1, 1).byteLength).toBe(INPUT_BYTES);
    expect(INPUT_BYTES).toBe(7);
  });

  it('leve sur un buffer tronque plutot que de rendre une entree fantaisiste', () => {
    const truncated = encodeInput(1, 1, 1, 1, 1).slice(0, 3);

    expect(() => decodeInput(truncated)).toThrow(/tronqu/i);
  });

  // ⚠️ Coupe PILE avant les deux octets de visee. Sans cette coupe precise,
  // un decalage qui ecrirait aimX/aimY hors de INPUT_BYTES passerait inapercu
  // tant que le buffer alloue absorbe l'erreur.
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
  it('rend les positions arrondies a l entier, les pv personnels, la visee, l experience, la synergie d equipe, le boss et l or', () => {
    const buf = encodeSnapshot(
      42,
      12_000,
      7,
      [
        { id: 1, x: 100.4, y: 200.6, hp: 80, aimX: 90, aimY: -60, pickupRadius: 90, shield: 0 },
        { id: 2, x: -3.2, y: 5999.9, hp: 42, aimX: 0, aimY: 0, pickupRadius: 170, shield: 0 },
      ],
      { id: 8193, hp: 6000 },
      31_337,
    );

    expect(decodeSnapshot(buf)).toEqual({
      type: MSG.SNAPSHOT,
      tick: 42,
      xp: 12_000,
      synergy: 7,
      players: [
        { id: 1, x: 100, y: 201, hp: 80, aimX: 90, aimY: -60, pickupRadius: 90, shield: 0 },
        { id: 2, x: -3, y: 6000, hp: 42, aimX: 0, aimY: 0, pickupRadius: 170, shield: 0 },
      ],
      boss: { id: 8193, hp: 6000 },
      gold: 31_337,
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
  it('tient exactement SNAPSHOT_HEADER_BYTES + n * SNAPSHOT_PLAYER_BYTES octets (18 -> 22 avec l or)', () => {
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 3, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
    ]);

    expect(buf.byteLength).toBe(SNAPSHOT_HEADER_BYTES + 3 * SNAPSHOT_PLAYER_BYTES);
    expect(SNAPSHOT_HEADER_BYTES).toBe(22);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(11);
  });

  it('tient les pv personnels sur un octet (u8, borne 255)', () => {
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 255, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
    ]);

    expect(decodeSnapshot(buf).players[0]).toEqual({
      id: 1,
      x: 0,
      y: 0,
      hp: 255,
      aimX: 0,
      aimY: 0,
      pickupRadius: 90,
      shield: 0,
    });
  });

  // ⚠️ `setUint16` applique un modulo 2^16 a quiconque l'appelle sans cette
  // garde, meme si `Room#grantCard` plafonne deja `hp` a zero pour un mort.
  // Sans la borne, `hp = -40` (un mort qui recevrait un malus de PV max)
  // partirait sur le fil a 65 496 : un mort affiche a PV quasi plein.
  it('un hp negatif ressort a zero au decodage, jamais replie pres de 65 536', () => {
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: -40, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
    ]);

    expect(decodeSnapshot(buf).players[0]?.hp).toBe(0);
  });

  it('borne la visee redistribuee a -127..127, comme celle d un INPUT (tache 13)', () => {
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 500, aimY: -500, pickupRadius: 90, shield: 0 },
    ]);

    expect(decodeSnapshot(buf).players[0]).toMatchObject({ aimX: 127, aimY: -127 });
  });

  it("tient l'experience d'equipe sur deux octets (u16, borne 65 535)", () => {
    const buf = encodeSnapshot(1, 65_535, 0, []);

    expect(decodeSnapshot(buf).xp).toBe(65_535);
  });

  it('tient la synergie d equipe sur deux octets (u16, borne 65 535)', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 65_535, [])).synergy).toBe(65_535);
  });

  // ⚠️ Un champ n'est pas assez large parce qu'il en a l'air (un `hp` sur un
  // octet a deja replie 260 PV en 4) : on confronte la valeur que le JEU
  // produit a la largeur du champ, sans reecrire le plafond en dur.
  it('SYNERGY_MAX tient dans le u16 du snapshot, sans repli silencieux', () => {
    expect(SYNERGY_MAX).toBeLessThanOrEqual(65_535);
    expect(decodeSnapshot(encodeSnapshot(1, 0, SYNERGY_MAX, [])).synergy).toBe(SYNERGY_MAX);
  });

  it('PLAYER_MAX_HP tient dans un octet (u8)', () => {
    expect(PLAYER_MAX_HP).toBeLessThanOrEqual(255);
  });

  /**
   * ⚠️ **Un buffer trop court pour porter meme son compte de joueurs.** C'est
   * le SEUL cas que le premier controle de `decodeSnapshot` garde a lui seul :
   * sans lui, `getUint8(5)` leverait un `RangeError` de `DataView` au lieu de
   * dire « tronque ». Et c'est bien `/tronqu/` qui est exige — un
   * `toThrow()` nu passerait sur le `RangeError` sans rien prouver.
   */
  it('leve sur un buffer trop court pour porter son compte de joueurs', () => {
    expect(() => decodeSnapshot(new ArrayBuffer(5))).toThrow(/tronqu/i);
  });

  // ⚠️ Coupe PILE avant les deux octets de synergie (elle occupe les octets 8
  // et 9 de l'en-tete). Sans lui, un en-tete qui n'exigerait que ses 8 octets
  // d'avant rendrait une synergie fantaisiste au lieu de lever.
  it('leve sur un en-tete tronque juste avant la synergie d equipe', () => {
    const truncated = encodeSnapshot(1, 12_000, 7, []).slice(0, 8);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });

  // ⚠️ **Coupe PILE avant les quatre octets de PV du boss** (identite lue,
  // vie manquante). Et `toThrow(/tronqu/i)`, jamais `toThrow()` nu : un
  // `RangeError` de `DataView` le ferait passer meme sans controle de longueur.
  it('leve sur un en-tete tronque juste avant les PV du boss', () => {
    // ⚠️ **14, pas `SNAPSHOT_HEADER_BYTES - 4`** : l'or suit les PV du boss
    // dans l'en-tete, et une coupe relative a la fin couperait avant l'OR.
    // L'octet vise est nomme par sa position, pas par sa distance a la fin.
    const truncated = encodeSnapshot(1, 12_000, 7, [], { id: 8193, hp: 6000 }).slice(0, 14);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });

  // ⚠️ Coupe PILE avant les quatre octets d'or (ils occupent 18..21). Meme
  // exigence qu'ailleurs : `/tronqu/i`, jamais un `toThrow()` nu — un
  // `RangeError` de `DataView` le ferait passer sans controle de longueur.
  it('leve sur un en-tete tronque juste avant l or de l equipe', () => {
    const truncated = encodeSnapshot(1, 12_000, 7, [], { id: 8193, hp: 6000 }, 31_337).slice(0, 18);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });

  it("leve quand l'en-tete annonce plus de joueurs que le buffer n'en contient", () => {
    const truncated = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
    ]).slice(0, SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });

  // ⚠️ Coupe PILE avant les deux octets de visee du premier joueur (les 6
  // premiers octets du bloc passent, aimX/aimY manquent). Sans ce test, un
  // decalage qui placerait aimX/aimY hors du bloc pourrait passer inapercu.
  it('leve sur un buffer tronque juste avant la visee du joueur (tache 13)', () => {
    const truncated = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 90, aimY: -60, pickupRadius: 90, shield: 0 },
    ]).slice(0, SNAPSHOT_HEADER_BYTES + 6);

    expect(() => decodeSnapshot(truncated)).toThrow(/tronqu/i);
  });
});

describe('etape 7b tache 7 : le rayon de ramassage voyage par joueur', () => {
  /**
   * ⚠️ **Epingle en chiffres NUS** : une assertion `toBe(SNAPSHOT_PLAYER_BYTES)`
   * serait vraie quoi qu'il arrive. Chaque octet par joueur se paie a chaque
   * tick : le grossir doit faire rougir ce test.
   */
  it('SNAPSHOT_PLAYER_BYTES vaut 11, et le snapshot a quatre joueurs fait 66 octets', () => {
    expect(SNAPSHOT_HEADER_BYTES).toBe(22);
    expect(SNAPSHOT_PLAYER_BYTES).toBe(11);
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 3, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 4, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
    ]);
    expect(buf.byteLength).toBe(66);
  });

  it('le rayon fait l aller-retour, par joueur', () => {
    const buf = encodeSnapshot(1, 0, 0, [
      { id: 1, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0 },
      { id: 2, x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 170, shield: 0 },
    ]);
    const msg = decode(buf);
    if (msg.type !== MSG.SNAPSHOT) {
      throw new Error('type inattendu');
    }
    expect(msg.players.map((p) => p.pickupRadius)).toEqual([90, 170]);
  });

  // ⚠️ **Pas de test du `Math.min(255, ...)` de l'encodeur, deliberement** :
  // le maximum atteignable (90 + maxBonus('pickupRadius') = 170, voir
  // `shared/shop.test.ts`) ne touche jamais 255, et un test qui pretendrait
  // declencher cette borne serait du theatre. C'est l'invariant du catalogue
  // qui garde cette propriete.
});

/**
 * ⚠️ **La seule donnee PAR ENTITE que ce protocole transporte, et c'est le
 * NOMBRE qui l'autorise** : un seul boss vivant. Dix boss seraient de la
 * pietaille d'elite, dont la vie reste serveur seul.
 */
describe('le boss dans le snapshot (etape 6a, tache 4)', () => {
  /** Une identite d'entite REELLE : vague 2, indice 1. Jamais un nombre invente. */
  const BOSS_ID = entityIdOf(2, 1);

  /**
   * Premier palier ou un `u16` aurait deborde, **CALCULE ici** : il suit
   * `BOSS_HP_PER_PLAYER` et `PALIER_HP_SCALE` s'ils bougent.
   */
  const PALIER_LIMITE_U16 = ((): number => {
    let k = 0;
    while (bossHp(k, MAX_PLAYERS) <= 65_535) {
      k++;
    }
    return k;
  })();

  it('rend l identite et les points de vie du boss, distincts de tout le reste', () => {
    // ⚠️ Toutes les valeurs sont DISTINCTES — 42, 12 000, 7, l'identite, les
    // PV — parce qu'un aller-retour ne voit pas un decalage d'octet qui
    // echange deux champs de MEME valeur.
    const decoded = decodeSnapshot(
      encodeSnapshot(
        42,
        12_000,
        7,
        [{ id: 3, x: 11, y: 22, hp: 33, aimX: 44, aimY: -55, pickupRadius: 90, shield: 0 }],
        {
          id: BOSS_ID,
          hp: 6000,
        },
      ),
    );

    expect(decoded.boss).toEqual({ id: BOSS_ID, hp: 6000 });
    // Et rien d'autre n'a bouge : le boss s'ajoute a l'en-tete, il ne s'ecrit
    // par-dessus personne.
    expect(decoded.tick).toBe(42);
    expect(decoded.xp).toBe(12_000);
    expect(decoded.synergy).toBe(7);
    expect(decoded.players).toEqual([
      { id: 3, x: 11, y: 22, hp: 33, aimX: 44, aimY: -55, pickupRadius: 90, shield: 0 },
    ]);
  });

  it('rend null quand aucun boss n est en jeu', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [])).boss).toBeNull();
  });

  /**
   * ⚠️ **La sentinelle ne peut PAS valoir une identite reelle, et ce test le
   * DERIVE de `entityIdOf`.** Les identites valent `waveId * MAX_PER_WAVE +
   * index` et le premier `waveId` vaut 1 : le plus petit numero atteignable
   * est donc `MAX_PER_WAVE`.
   */
  it('choisit une sentinelle qu aucune identite d entite ne peut atteindre', () => {
    expect(NO_BOSS_ID).toBeLessThan(entityIdOf(1, 0));
    expect(entityIdOf(1, 0)).toBe(MAX_PER_WAVE);
  });

  /**
   * ⚠️ **La sentinelle est sur l'IDENTITE, pas sur les PV.** Un boss a 0 PV est
   * un boss : il meurt au tick suivant, par `DEATHS`. Le lire comme « pas de
   * boss » ferait disparaitre sa barre juste avant sa mort.
   */
  it('distingue un boss a zero PV d une absence de boss', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], { id: BOSS_ID, hp: 0 })).boss).toEqual({
      id: BOSS_ID,
      hp: 0,
    });
  });

  /**
   * ⚠️ On confronte la valeur que le JEU produit a la largeur du champ, en la
   * CALCULANT plutot qu'en recopiant un nombre : un champ trop etroit replie
   * en silence.
   */
  it('tient le boss le plus lourd que le jeu sache produire, sans repli silencieux', () => {
    // Le boss d'une equipe pleine, palier par palier, jusqu'a la ou un u16
    // aurait deja replie.
    const auPalierU16 = bossHp(PALIER_LIMITE_U16, MAX_PLAYERS);
    expect(auPalierU16).toBeGreaterThan(65_535);
    expect(auPalierU16).toBeLessThanOrEqual(BOSS_HP_MAX);
    expect(
      decodeSnapshot(encodeSnapshot(1, 0, 0, [], { id: BOSS_ID, hp: auPalierU16 })).boss?.hp,
    ).toBe(Math.round(auPalierU16));

    // Et la borne du u32 elle-meme, a l'unite pres.
    expect(
      decodeSnapshot(encodeSnapshot(1, 0, 0, [], { id: BOSS_ID, hp: BOSS_HP_MAX })).boss?.hp,
    ).toBe(BOSS_HP_MAX);
  });

  /**
   * ⚠️ **Au-dela du u32, on BORNE, on ne replie pas.** `setUint32` prendrait le
   * modulo : un boss de 4,3 milliards de PV se reveillerait a quelques
   * centaines. Le palier ou cela arrive (119, ~10 h de jeu) est hors de
   * portee, mais un repli silencieux ne se rattrape pas : il se refuse.
   */
  it('borne au lieu de replier au-dela du u32', () => {
    const decoded = decodeSnapshot(
      encodeSnapshot(1, 0, 0, [], { id: BOSS_ID, hp: BOSS_HP_MAX + 1000 }),
    );

    expect(decoded.boss?.hp).toBe(BOSS_HP_MAX);
    // Le repli, lui, aurait rendu 999 : le dire, sinon « borne » et « replie »
    // se ressemblent trop pour qu'un test les separe.
    expect((BOSS_HP_MAX + 1000) % 2 ** 32).toBe(999);
  });

  it('arrondit les PV a l entier, comme les positions', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], { id: BOSS_ID, hp: 1499.6 })).boss?.hp).toBe(
      1500,
    );
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
      kind: ELEMENT.GIVRE,
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
  // ⚠️ Pas d'octet `owner` : toute carte est ouverte a tout le monde. Une
  // carte tient en QUATRE octets (le quatrieme est la rarete), et c'est
  // l'assertion de taille ci-dessous qui le garde.
  //
  // Les trois cartes ne partagent ni nature ni `refId` : un encodeur qui
  // intervertirait les deux octets se verrait.
  const cartes = [
    { nature: 0, refId: 3, upgrade: 2, rarity: 0 },
    { nature: 1, refId: 7, upgrade: 0, rarity: 2 },
    { nature: 0, refId: 8, upgrade: 1, rarity: 1 },
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
    // ⚠️ La ligne ci-dessus se calcule AVEC la constante : elle passerait si
    // la constante mentait aussi. Le chiffre nu garde la taille de la carte.
    expect(DRAFT_CARD_BYTES).toBe(4);
    // ⚠️ **Meme trou, meme remede, cote en-tete** : un en-tete qui grossirait
    // resterait invisible, encodeur et decodeur partageant la meme constante.
    expect(DRAFT_OPEN_HEADER_BYTES).toBe(6);
    expect(encodeDraftOpen(1, cartes).byteLength).toBe(DRAFT_OPEN_HEADER_BYTES + 12);
  });

  it('leve sur un tampon tronque', () => {
    const buf = encodeDraftOpen(1, cartes);
    expect(() => decode(buf.slice(0, DRAFT_OPEN_HEADER_BYTES + 1))).toThrow(/tronque/);
  });

  it('etape 10 : la rarete est le QUATRIEME octet de chaque carte', () => {
    const buf = encodeDraftOpen(1, cartes);
    const v = new DataView(buf);
    expect(v.getUint8(DRAFT_OPEN_HEADER_BYTES + 3)).toBe(0);
    expect(v.getUint8(DRAFT_OPEN_HEADER_BYTES + DRAFT_CARD_BYTES + 3)).toBe(2);
    expect(v.getUint8(DRAFT_OPEN_HEADER_BYTES + 2 * DRAFT_CARD_BYTES + 3)).toBe(1);
  });

  it('etape 10 : une carte sans rarete part commune, et un octet inconnu revient tel quel', () => {
    const msg = decode(
      encodeDraftOpen(1, [
        { nature: 1, refId: 2 },
        { nature: 1, refId: 3, rarity: 200 },
      ]),
    );
    if (msg.type !== MSG.DRAFT_OPEN) {
      throw new Error('type inattendu');
    }
    expect(msg.cards[0]?.rarity).toBe(0);
    // Le fil ne juge pas : c'est `normalizeRarity` qui ramene 200 a commune.
    expect(msg.cards[1]?.rarity).toBe(200);
  });

  it('etape 10 : 6 + 5 x 4 = 26 octets a deux joueurs, un octet de plus par carte et rien d autre', () => {
    const cinq = [...cartes, ...cartes.slice(0, 2)];
    expect(cinq).toHaveLength(5);
    expect(encodeDraftOpen(1, cinq).byteLength).toBe(26);
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
    // ⚠️ Le message n'a qu'un sens possible (la resolution est un seul
    // moment), donc pas d'octet `phase`. Ce qui reste indispensable, c'est
    // `deadlineTick` : la fenetre dure jusqu'a ce que tout le monde ait pose
    // son jeton, et en solo elle se ferme au clic, donc chaque client
    // devinerait une fin de gel differente. On eprouve DEUX echeances
    // distinctes : un champ code en dur passerait avec une seule.
    for (const deadline of [700, 0x1234_5678]) {
      const msg = decode(encodeDraftResult(deadline, issues));
      if (msg.type !== MSG.DRAFT_RESULT) {
        throw new Error('type inattendu');
      }
      expect(msg.deadlineTick).toBe(deadline);
    }
  });

  it('tient sur SIX octets d en-tete : l octet de phase a disparu', () => {
    // Un en-tete de sept octets se decoderait sans lever, en decalant
    // simplement toutes les issues : seule la taille le voit.
    expect(DRAFT_RESULT_HEADER_BYTES).toBe(6);
    expect(encodeDraftResult(900, []).byteLength).toBe(6);
  });

  it('leve un message TRONQUE explicite, pas une erreur de bornes fortuite', () => {
    // ⚠️ Un `toThrow()` nu ne prouve rien ici : sans le controle de longueur,
    // le `DataView` finit par lever tout seul. C'est le MESSAGE qui rend ce
    // controle porteur.
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
  // pour deux reactions.
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
  // quartet : seize elements au plus. La marge est verifiee, pas supposee :
  // un dix-septieme element replierait les couples en silence.
  it('garde la marge du quartet : au plus seize elements', () => {
    expect(ELEMENTS.length).toBeLessThanOrEqual(16);
  });
});

/**
 * `ZONE` porte un seul `u8` pour un COUPLE : l'element dans les bits 0-2, le
 * type de champ de reaction dans les bits 3-6.
 */
describe('packZoneKind / zoneElement / zoneReaction', () => {
  /**
   * ⚠️ **6 x 16, pas seulement quelques echantillons.** Six elements tiennent
   * sur 3 bits (0-7, six sont prevus), seize types de reaction sur 4 (0-15) :
   * l'aller-retour couvre les deux bornes des deux champs, pas seulement leurs
   * valeurs de production actuelles.
   */
  it('rend l element et la reaction exacts, sur toutes les combinaisons 6 x 16', () => {
    for (let element = 0; element <= 5; element++) {
      for (let reaction = 0; reaction <= 15; reaction++) {
        const kind = packZoneKind(element, reaction);

        expect(zoneElement(kind), `element=${element} reaction=${reaction}`).toBe(element);
        expect(zoneReaction(kind), `element=${element} reaction=${reaction}`).toBe(reaction);
      }
    }
  });

  // ⚠️ **Le decor qui masque** : `packZoneKind(element, 0)` vaut
  // NUMERIQUEMENT `element`, donc un aller-retour avec une reaction nulle
  // passerait avec une fonction identite. Ce test exige `kind !== element`.
  it('kind differe de l element seul des qu une reaction est empaquetee', () => {
    const kind = packZoneKind(ELEMENT.GIVRE, 5);

    expect(kind).not.toBe(ELEMENT.GIVRE);
    expect(zoneElement(kind)).toBe(ELEMENT.GIVRE);
    expect(zoneReaction(kind)).toBe(5);
  });

  it('une reaction nulle rend bien un kind egal a l element seul — le cas degenere, assene', () => {
    expect(packZoneKind(ELEMENT.BRAISE, 0)).toBe(ELEMENT.BRAISE);
  });

  it('tient sur SEPT bits : le bit 7 reste toujours a zero', () => {
    // 0xff largement hors des deux plages (3 et 4 bits) : le masquage doit
    // border les deux champs avant de les combiner, jamais laisser deborder
    // dans le bit de poids fort.
    expect(packZoneKind(0xff, 0xff) & 0x80).toBe(0);
  });

  it('les deux champs ne se melangent jamais : changer l un laisse l autre intact', () => {
    const base = packZoneKind(ELEMENT.FOUDRE, 7);

    for (let reaction = 0; reaction <= 15; reaction++) {
      expect(zoneElement(packZoneKind(ELEMENT.FOUDRE, reaction))).toBe(ELEMENT.FOUDRE);
    }
    for (let element = 0; element <= 5; element++) {
      expect(zoneReaction(packZoneKind(element, 7))).toBe(7);
    }
    expect(zoneElement(base)).toBe(ELEMENT.FOUDRE);
    expect(zoneReaction(base)).toBe(7);
  });

  // ⚠️ **Zero octet de plus** : `ZONE` reste a 11 octets, le couple tient
  // dans l'octet qu'il avait deja.
  it('ZONE_BYTES reste a 11 : le couple tient dans l octet existant', () => {
    expect(ZONE_BYTES).toBe(11);
  });
});

describe('encodeBossCharge / decodeBossCharge', () => {
  /**
   * Les dix champs sont assenes sur des valeurs TOUTES DISTINCTES : un
   * aller-retour qui n'en verifierait que deux passerait meme si les huit autres
   * etaient ecrases, et deux champs de meme valeur masqueraient un decalage
   * d'octet qui les echange.
   */
  it('rend exactement la charge encodee, ses dix champs', () => {
    const charge = {
      entityId: 8193,
      x: -1234,
      y: 5678,
      dirX: 0.6,
      dirY: -0.8,
      length: 900,
      width: 192,
      windupTick: 90_001,
      startTick: 90_031,
      endTick: 90_049,
    };

    expect(decodeBossCharge(encodeBossCharge(charge))).toEqual({
      type: MSG.BOSS_CHARGE,
      ...charge,
    });
  });

  /**
   * ⚠️ Le serveur derive la position du boss depuis la charge qu'il a
   * construite ; le client depuis celle qu'il decode. Si l'aller-retour
   * changeait le moindre bit d'une composante, les deux suivraient deux
   * couloirs voisins mais distincts, et l'ecart croitrait tout du long.
   * `makeBossCharge` quantifie donc A LA CONSTRUCTION, et ce test verifie
   * que la valeur construite survit au fil A L'IDENTIQUE.
   */
  it('rend une charge BIT POUR BIT identique a celle que `makeBossCharge` a construite', () => {
    // Une direction volontairement irrationnelle : ni axiale, ni a 45 degres,
    // donc ses deux composantes ont une infinite de decimales avant
    // quantification. Un aller-retour approximatif se verrait ici, jamais sur
    // (1, 0).
    const built = makeBossCharge(8193, 1234.7, 2345.2, 4000, 3111, 700);
    const decoded = decodeBossCharge(encodeBossCharge(built));

    expect({ ...decoded, type: undefined }).toEqual({ ...built, type: undefined });
    expect(decoded.dirX).toBe(built.dirX);
    expect(decoded.dirY).toBe(built.dirY);
  });

  it('tient exactement BOSS_CHARGE_BYTES octets, et BOSS_CHARGE_BYTES en fait 29', () => {
    const built = makeBossCharge(1, 0, 0, 100, 0, 0);
    expect(encodeBossCharge(built).byteLength).toBe(BOSS_CHARGE_BYTES);
    expect(BOSS_CHARGE_BYTES).toBe(29);
  });

  it('leve un message TRONQUE explicite sur un tampon court', () => {
    const truncated = encodeBossCharge(makeBossCharge(1, 0, 0, 100, 0, 0)).slice(
      0,
      BOSS_CHARGE_BYTES - 1,
    );

    expect(() => decodeBossCharge(truncated)).toThrow(/tronqu/);
  });

  it('est aiguille par `decode` sur son seul octet de type', () => {
    const built = makeBossCharge(8193, 10, 20, 500, 20, 3);
    const decoded = decode(encodeBossCharge(built));

    expect(decoded.type).toBe(MSG.BOSS_CHARGE);
    expect(decoded).toEqual(decodeBossCharge(encodeBossCharge(built)));
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
      kind: ELEMENT.GIVRE,
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
  // charge passe avec un encodeur qui met 1 en dur, et la Synergie monterait
  // alors a chaque reaction, solo comprise.
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
  // que dans un second, et une reaction chargee pese ce que pese une
  // reaction solo.
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

/**
 * ⚠️ **L'or, troisieme grandeur d'EQUIPE de l'en-tete** apres l'experience et
 * la Synergie : c'est le nombre que le vote met en jeu. Il est repete a chaque
 * tick plutot qu'annonce par evenement : un client qui aurait manque un
 * `PORTAL_RESULT` se recale au snapshot suivant.
 */
describe("l'or dans le snapshot (etape 6a, tache 7)", () => {
  /** Or cumule apres avoir vaincu les boss des paliers 0 a `k`. */
  function cumulJusquA(k: number): number {
    let total = 0;
    for (let i = 0; i <= k; i++) {
      total += palierGold(i);
    }
    return total;
  }

  /**
   * Le palier auquel un `u16` aurait replie la cagnotte, **derive de
   * `palierGold`, jamais recopie** : il suit `GOLD_PER_PALIER_BASE` et
   * `PALIER_HP_SCALE` s'ils bougent.
   */
  const PALIER_LIMITE_U16 = (() => {
    let k = 0;
    while (cumulJusquA(k) <= 65_535) {
      k++;
    }
    return k;
  })();

  /**
   * ⚠️ **La largeur est calculee, pas devinee** (table complete dans la doc
   * de `GOLD_MAX`). Un `u16` deborderait en moins de deux heures de jeu une
   * fois l'or majore du multiplicateur d'extraction, et rien ne borne le
   * palier. Le repli ramenerait la cagnotte a presque rien, PILE au moment ou
   * elle vaut le plus cher.
   */
  it('tient la plus grosse cagnotte que le jeu sache produire, sans repli silencieux', () => {
    const auPalierU16 = cumulJusquA(PALIER_LIMITE_U16);

    expect(auPalierU16).toBeGreaterThan(65_535);
    expect(auPalierU16).toBeLessThanOrEqual(GOLD_MAX);
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, auPalierU16)).gold).toBe(auPalierU16);
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, GOLD_MAX)).gold).toBe(GOLD_MAX);
  });

  /**
   * ⚠️ **Borne, jamais repli.** Sans le `Math.min`, `setUint32` prend le
   * modulo : une cagnotte de 4,3 milliards de pieces se reveillerait a 999.
   * Meme garde que pour les PV du boss.
   */
  it('borne au lieu de replier au-dela de GOLD_MAX', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, GOLD_MAX + 1000)).gold).toBe(GOLD_MAX);
    // Ce qu'un repli aurait rendu, pour que la ligne ci-dessus ait un sens.
    expect((GOLD_MAX + 1000) % 2 ** 32).toBe(999);
  });

  /**
   * L'or reste entier sur le fil. Le seul chemin par lequel il peut cesser de
   * l'etre est le multiplicateur d'extraction ; sans cet arrondi, `setUint32`
   * tronquerait vers zero et une extraction perdrait une piece.
   */
  it("arrondit l'or a l'entier plutot que de le tronquer", () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, 1499.6)).gold).toBe(1500);
  });

  it('vaut zero quand rien n a encore ete gagne', () => {
    expect(decodeSnapshot(encodeSnapshot(1, 0, 0, [])).gold).toBe(0);
  });
});

/**
 * **Quatre messages, calques sur le draft** : une ouverture datee, des
 * intentions rediffusees, une resolution annoncee. Ce qui change : deux choix
 * au lieu de N cartes, **aucun gel**, et une majorite au lieu d'un tirage.
 *
 * ⚠️ **Les trois regles du draft sont gardees ici** : le resultat porte le
 * TICK D'EFFET, la sentinelle d'abstention ne vaut aucun choix reel, et ce
 * que le serveur COMPARE ne voyage pas (seul son verdict voyage, comme
 * `REACTION` porte un bit et non les deux joueurs).
 */
describe('le vote d extraction (etape 6a, tache 7)', () => {
  describe('PORTAL_OPEN', () => {
    it('fait un aller-retour exact', () => {
      expect(decode(encodePortalOpen(4242, 1.75))).toEqual({
        type: MSG.PORTAL_OPEN,
        deadlineTick: 4242,
        multiplier: 1.75,
      });
    });

    it('tient un tick d echeance sur 32 bits', () => {
      const msg = decode(encodePortalOpen(4_294_967_295, 1));

      expect(msg).toMatchObject({ deadlineTick: 4_294_967_295 });
    });

    /**
     * ⚠️ **Le multiplicateur passe a 0,01 pres, et les DEUX champs se lisent
     * dans le meme message.** Un decodeur qui lirait le multiplicateur au
     * mauvais offset rendrait un nombre plausible tire des octets du tick — le
     * decor prend donc un tick dont les deux octets de poids fort (`0x0004`)
     * ne ressemblent a aucun multiplicateur legitime.
     */
    it('porte le multiplicateur d extraction a cote du tick, sans les confondre', () => {
      const msg = decode(encodePortalOpen(262_144, 2.25));

      expect(msg).toEqual({ type: MSG.PORTAL_OPEN, deadlineTick: 262_144, multiplier: 2.25 });
    });

    /**
     * ⚠️ **La borne du multiplicateur, et elle n'est pas decorative.**
     * `setUint16` replie modulo 2^16 : sans le `Math.min` de l'encodeur,
     * 655,36 (= 65 536 centiemes) se relirait **0,00**, c'est-a-dire « partir
     * ne rapporte rien » au moment exact ou partir rapporte le plus. Le palier
     * ou ca arrive — 2 618 « rester » d'affilee — est tres au-dela du palier
     * 107 ou `extractGold` sature deja `GOLD_MAX`.
     */
    it('sature le multiplicateur au lieu de le replier a zero', () => {
      expect(decode(encodePortalOpen(1, EXTRACT_MULTIPLIER_MAX))).toMatchObject({
        multiplier: EXTRACT_MULTIPLIER_MAX,
      });
      expect(decode(encodePortalOpen(1, EXTRACT_MULTIPLIER_MAX + 0.01))).toMatchObject({
        multiplier: EXTRACT_MULTIPLIER_MAX,
      });
      expect(decode(encodePortalOpen(1, 1_000_000))).toMatchObject({
        multiplier: EXTRACT_MULTIPLIER_MAX,
      });
    });

    // Taille assenee EN CHIFFRE NU : `toBe(PORTAL_OPEN_BYTES)` seul serait
    // vraie quoi qu'il arrive.
    it('tient exactement PORTAL_OPEN_BYTES octets', () => {
      expect(encodePortalOpen(1, 1).byteLength).toBe(PORTAL_OPEN_BYTES);
      expect(PORTAL_OPEN_BYTES).toBe(7);
    });

    it('leve sur un buffer tronque plutot que de rendre une echeance fantaisiste', () => {
      const tronque = encodePortalOpen(4242, 1).slice(0, PORTAL_OPEN_BYTES - 1);

      expect(() => decode(tronque)).toThrow(/tronqu/i);
    });
  });

  describe('VOTE', () => {
    it('porte chacun des deux choix, et le retrait', () => {
      expect(decode(encodeVote(VOTE_CHOICE.STAY))).toEqual({
        type: MSG.VOTE,
        choice: VOTE_CHOICE.STAY,
      });
      expect(decode(encodeVote(VOTE_CHOICE.LEAVE))).toEqual({
        type: MSG.VOTE,
        choice: VOTE_CHOICE.LEAVE,
      });
      expect(decode(encodeVote(NO_VOTE))).toEqual({ type: MSG.VOTE, choice: NO_VOTE });
    });

    it('tient exactement VOTE_BYTES octets', () => {
      expect(encodeVote(VOTE_CHOICE.STAY).byteLength).toBe(VOTE_BYTES);
      expect(VOTE_BYTES).toBe(2);
    });

    it('leve sur un buffer tronque', () => {
      expect(() => decode(encodeVote(VOTE_CHOICE.LEAVE).slice(0, 1))).toThrow(/tronqu/i);
    });

    /**
     * ⚠️ **La sentinelle est gardee par sa PROPRIETE, pas par son chiffre.**
     * `toBe(255)` passerait meme si `VOTE_CHOICE` grandissait jusqu'a
     * l'atteindre. Ce qui doit rester vrai, c'est qu'aucun vote REEL ne vaut
     * la sentinelle.
     *
     * ⚠️ **Et `0` serait le pire choix possible**, parce que `STAY` vaut zero :
     * toutes les abstentions se compteraient comme des voix pour rester, alors
     * que ce cas releve de la regle d'egalite. La difference se voit des qu'un
     * seul joueur vote « partir ».
     */
    it('la sentinelle d abstention ne vaut aucun vote reel', () => {
      const reels: number[] = Object.values(VOTE_CHOICE);

      expect(reels).not.toContain(NO_VOTE);
      expect(NO_VOTE).toBeGreaterThan(Math.max(...reels));
    });

    // Le meme octet de choix circule dans les trois messages : une seconde
    // convention pour « rester » ou pour l'abstention les rendrait illisibles
    // l'un par l'autre.
    it('tient sur un octet, sentinelle comprise', () => {
      const toutes = [...Object.values(VOTE_CHOICE), NO_VOTE];

      for (const valeur of toutes) {
        expect(valeur).toBeGreaterThanOrEqual(0);
        expect(valeur).toBeLessThanOrEqual(255);
      }
    });
  });

  describe('VOTES', () => {
    // ⚠️ **Trois joueurs, trois choix TOUS DIFFERENTS, et des identifiants qui
    // ne valent aucun choix.** Un encodeur qui intervertirait les deux octets
    // d'une entree, ou qui recopierait la premiere, se verrait ; une liste ou
    // tout le monde vote pareil ne verrait ni l'un ni l'autre.
    const votes = [
      { playerId: 4, choice: VOTE_CHOICE.LEAVE },
      { playerId: 7, choice: VOTE_CHOICE.STAY },
      { playerId: 9, choice: NO_VOTE },
    ];

    it('fait un aller-retour exact, abstention comprise', () => {
      expect(decode(encodeVotes(votes))).toEqual({ type: MSG.VOTES, votes });
    });

    /**
     * ⚠️ **L'abstention CIRCULE : elle ne se compte pas, mais elle se voit.**
     * Les autres doivent savoir qui n'a pas encore tranche, c'est la matiere
     * de la negociation. Un encodeur qui filtrerait les abstentions ferait
     * disparaitre les indecis de l'ecran des autres.
     */
    it('diffuse aussi ceux qui n ont pas vote', () => {
      const msg = decode(encodeVotes(votes));
      if (msg.type !== MSG.VOTES) {
        throw new Error('type inattendu');
      }

      expect(msg.votes).toHaveLength(3);
      expect(msg.votes.filter((v) => v.choice === NO_VOTE)).toEqual([
        { playerId: 9, choice: NO_VOTE },
      ]);
    });

    it('a la taille exacte annoncee par ses constantes', () => {
      expect(encodeVotes(votes).byteLength).toBe(VOTES_HEADER_BYTES + 3 * VOTE_ENTRY_BYTES);
      expect(VOTES_HEADER_BYTES).toBe(2);
      expect(VOTE_ENTRY_BYTES).toBe(2);
      expect(encodeVotes(votes).byteLength).toBe(8);
    });

    it('encode une liste vide', () => {
      expect(decode(encodeVotes([]))).toEqual({ type: MSG.VOTES, votes: [] });
    });

    it('leve quand l en-tete annonce plus de votes que le buffer n en contient', () => {
      const tronque = encodeVotes(votes).slice(0, VOTES_HEADER_BYTES + VOTE_ENTRY_BYTES);

      expect(() => decode(tronque)).toThrow(/tronqu/i);
    });
  });

  describe('PORTAL_RESULT', () => {
    /**
     * ⚠️ **Trois valeurs TOUTES DISTINCTES**, et aucune n'est l'indice d'une
     * autre : un decalage d'octet qui echangerait deux champs de meme valeur
     * ne se verrait pas.
     */
    it('rend le tick d effet, le verdict et l or, en partant', () => {
      expect(decode(encodePortalResult(7331, VOTE_CHOICE.LEAVE, 31_337))).toEqual({
        type: MSG.PORTAL_RESULT,
        effectTick: 7331,
        decision: VOTE_CHOICE.LEAVE,
        gold: 31_337,
      });
    });

    /**
     * ⚠️ **UN seul champ d'or, dont le sens se lit dans `decision`** : acquis
     * si l'equipe part, reporte si elle reste. Deux champs en laisseraient
     * toujours un a zero.
     */
    it('rend le meme champ d or en restant, ou il vaut l or REPORTE', () => {
      expect(decode(encodePortalResult(900, VOTE_CHOICE.STAY, 212))).toEqual({
        type: MSG.PORTAL_RESULT,
        effectTick: 900,
        decision: VOTE_CHOICE.STAY,
        gold: 212,
      });
    });

    /**
     * ⚠️ **Le TICK D'EFFET voyage.** Le client ne peut rien deduire : le vote
     * se resout des que la majorite est acquise, donc n'importe quand entre
     * l'ouverture et l'echeance. Un tick d'effet different de l'echeance
     * annoncee doit donc passer intact.
     */
    it('porte un tick d effet independant de l echeance annoncee a l ouverture', () => {
      const ouverture = decode(encodePortalOpen(1200, 1));
      const resultat = decode(encodePortalResult(1017, VOTE_CHOICE.STAY, 0));

      expect(ouverture).toMatchObject({ deadlineTick: 1200 });
      expect(resultat).toMatchObject({ effectTick: 1017 });
    });

    it('tient un tick d effet sur 32 bits et une cagnotte sur 32 bits', () => {
      const msg = decode(encodePortalResult(4_294_967_295, VOTE_CHOICE.LEAVE, GOLD_MAX));

      expect(msg).toMatchObject({ effectTick: 4_294_967_295, gold: GOLD_MAX });
    });

    /**
     * ⚠️ **Le meme nombre ne peut pas se replier d'un cote et pas de
     * l'autre.** L'or du `SNAPSHOT` et celui du `PORTAL_RESULT` sont la meme
     * cagnotte : deux bornes differentes feraient afficher deux fortunes
     * differentes selon le message lu.
     */
    it('borne et arrondit l or exactement comme le snapshot', () => {
      const msg = decode(encodePortalResult(1, VOTE_CHOICE.LEAVE, GOLD_MAX + 1000));
      const parLeSnapshot = decodeSnapshot(encodeSnapshot(1, 0, 0, [], null, GOLD_MAX + 1000));

      expect(msg).toMatchObject({ gold: parLeSnapshot.gold });
      expect(msg).toMatchObject({ gold: GOLD_MAX });
      expect(decode(encodePortalResult(1, VOTE_CHOICE.LEAVE, 1499.6))).toMatchObject({
        gold: 1500,
      });
    });

    /**
     * ⚠️ **Aucun decompte de voix sur le fil.** Ce que le serveur COMPARE n'a
     * pas a voyager ; seul son verdict voyage. Le detail est deja passe par
     * `VOTES`, ou il vaut quelque chose : pendant qu'on negocie. La taille en
     * chiffre nu garde cette decision : un decompte la ferait rougir.
     */
    it('tient exactement PORTAL_RESULT_BYTES octets, sans place pour un decompte', () => {
      expect(encodePortalResult(1, VOTE_CHOICE.STAY, 1).byteLength).toBe(PORTAL_RESULT_BYTES);
      expect(PORTAL_RESULT_BYTES).toBe(10);
    });

    it('leve sur un buffer tronque plutot que de rendre un verdict fantaisiste', () => {
      const tronque = encodePortalResult(7331, VOTE_CHOICE.LEAVE, 31_337).slice(
        0,
        PORTAL_RESULT_BYTES - 1,
      );

      expect(() => decode(tronque)).toThrow(/tronqu/i);
    });
  });

  /**
   * ⚠️ **`VOTE` et `DRAFT_TOKEN` font tous deux DEUX octets**, comme `ZONE` et
   * `REACTION` en faisaient onze : sans aiguillage sur le premier octet, l'un
   * se decoderait en l'autre sans qu'aucune borne ne proteste. On assene donc
   * le type ET un champ propre a chacun.
   */
  it('aiguille les quatre messages sur leur premier octet', () => {
    expect(decode(encodePortalOpen(4242, 1)).type).toBe(MSG.PORTAL_OPEN);
    expect(decode(encodeVote(VOTE_CHOICE.LEAVE))).toEqual({
      type: MSG.VOTE,
      choice: VOTE_CHOICE.LEAVE,
    });
    expect(decode(encodeDraftToken(NO_TOKEN))).toEqual({
      type: MSG.DRAFT_TOKEN,
      cardIndex: NO_TOKEN,
    });
    expect(decode(encodeVotes([{ playerId: 1, choice: VOTE_CHOICE.STAY }])).type).toBe(MSG.VOTES);
    expect(decode(encodePortalResult(1, VOTE_CHOICE.STAY, 1)).type).toBe(MSG.PORTAL_RESULT);
  });
});

describe('etape 7a tache 1 : HELLO porte le jeton, en largeur FIXE', () => {
  /**
   * ⚠️ **Les deux largeurs sont epinglees en chiffres NUS** : une assertion
   * `toBe(HELLO_BYTES)` serait vraie quoi qu'il arrive.
   */
  it('HELLO_BYTES vaut 33, et TOKEN_BYTES vaut 32', () => {
    expect(TOKEN_BYTES).toBe(32);
    expect(HELLO_BYTES).toBe(33);
    expect(HELLO_BYTES).toBe(1 + TOKEN_BYTES);
  });

  it('un jeton de 32 octets fait l aller-retour a l identique', () => {
    const token = new Uint8Array(TOKEN_BYTES);
    for (let i = 0; i < TOKEN_BYTES; i++) {
      token[i] = (i * 7 + 3) & 0xff;
    }
    const buf = encodeHello(token);
    expect(buf.byteLength).toBe(33);

    const msg = decode(buf);
    expect(msg.type).toBe(MSG.HELLO);
    if (msg.type !== MSG.HELLO) {
      throw new Error('type inattendu');
    }
    expect([...msg.token]).toEqual([...token]);
  });

  it('HELLO ne marche PAS sur le meme identifiant qu un message existant', () => {
    const existants = Object.entries(MSG)
      .filter(([nom]) => nom !== 'HELLO')
      .map(([, id]) => id);
    expect(existants).not.toContain(MSG.HELLO);
  });

  /**
   * Un HELLO tronque doit LEVER a l'encodage comme au decodage, jamais rendre
   * un jeton a moitie lu. C'est `viewOf` qui garde le decodage ; l'encodage se
   * garde lui-meme, parce qu'un jeton trop court produirait un message de la
   * bonne taille avec des zeros a la fin : un jeton VALIDE mais faux.
   */
  it('refuse un jeton qui ne fait pas exactement TOKEN_BYTES', () => {
    expect(() => encodeHello(new Uint8Array(0))).toThrow();
    expect(() => encodeHello(new Uint8Array(TOKEN_BYTES - 1))).toThrow();
    expect(() => encodeHello(new Uint8Array(TOKEN_BYTES + 1))).toThrow();
  });

  it('refuse un buffer HELLO tronque', () => {
    const court = new ArrayBuffer(10);
    new DataView(court).setUint8(0, MSG.HELLO);
    expect(() => decode(court)).toThrow(/tronque/);
  });
});

describe('etape 8 tache 3 : ABILITY / ABILITY_USED, le socle du verbe', () => {
  describe('ABILITY', () => {
    it('rend l aller-retour a l identique', () => {
      expect(decodeAbility(encodeAbility(1234, -100, 60))).toEqual({
        type: MSG.ABILITY,
        tick: 1234,
        aimX: -100,
        aimY: 60,
      });
    });

    /**
     * ⚠️ **Largeur epinglee en chiffre NU** : une assertion `toBe(ABILITY_BYTES)`
     * serait vraie quoi qu'il arrive.
     */
    it('tient exactement 9 octets : type u8 + tick u32 + aimX i16 + aimY i16', () => {
      expect(encodeAbility(1, 0, 0).byteLength).toBe(9);
      expect(ABILITY_BYTES).toBe(9);
    });

    it('refuse un buffer ABILITY tronque', () => {
      const tronque = encodeAbility(1, 0, 0).slice(0, ABILITY_BYTES - 1);
      expect(() => decode(tronque)).toThrow(/tronque/);
    });
  });

  describe('ABILITY_USED', () => {
    it('rend l aller-retour a l identique, cible comprise', () => {
      expect(decodeAbilityUsed(encodeAbilityUsed(500, 3, VERB_IDS.relais, -42, 17, 2))).toEqual({
        type: MSG.ABILITY_USED,
        tick: 500,
        playerId: 3,
        verb: VERB_IDS.relais,
        x: -42,
        y: 17,
        targetId: 2,
      });
    });

    /**
     * ⚠️ **12 octets** : `1 + 4 + 1 + 1 + 2 + 2 + 1`, sans octet de reserve.
     * Epinglee en chiffre NU, comme `ABILITY_BYTES` ci-dessus.
     */
    it('tient exactement 12 octets : type u8 + tick u32 + playerId u8 + verb u8 + x i16 + y i16 + targetId u8', () => {
      expect(encodeAbilityUsed(1, 1, 0, 0, 0, 0).byteLength).toBe(12);
      expect(ABILITY_USED_BYTES).toBe(12);
    });

    it('refuse un buffer ABILITY_USED tronque', () => {
      const tronque = encodeAbilityUsed(1, 1, 0, 0, 0, 0).slice(0, ABILITY_USED_BYTES - 1);
      expect(() => decode(tronque)).toThrow(/tronque/);
    });
  });

  it('ABILITY et ABILITY_USED ne marchent pas sur un identifiant de message existant', () => {
    const autres = Object.entries(MSG)
      .filter(([nom]) => nom !== 'ABILITY' && nom !== 'ABILITY_USED')
      .map(([, id]) => id);
    expect(autres).not.toContain(MSG.ABILITY);
    expect(autres).not.toContain(MSG.ABILITY_USED);
  });

  it('chaque verbe du catalogue a une recharge superieure a zero tick', () => {
    // Les reglages se lisent de `shared/abilities.ts`, jamais en dur ici (voir
    // `shared/abilities.test.ts` pour la garde de `VERB_IDS` /
    // `ABILITY_COOLDOWN_TICKS`).
    for (const verb of Object.values(VERB_IDS)) {
      expect(verb).toBeTypeOf('number');
    }
    expect(Object.values(ABILITY_COOLDOWN_TICKS).every((t) => t > 0)).toBe(true);
  });
});

describe('etape 9 : PING et PING_SHOWN', () => {
  it('PING fait 6 octets et revient a l identique, negatifs compris', () => {
    const buf = encodePing(3, -12, 32767);
    expect(buf.byteLength).toBe(PING_BYTES);
    expect(PING_BYTES).toBe(6);
    expect(decode(buf)).toEqual({ type: MSG.PING, intent: 3, x: -12, y: 32767 });
  });

  it('PING_SHOWN fait 7 octets et revient a l identique', () => {
    const buf = encodePingShown(4, 1, 5999, 0);
    expect(buf.byteLength).toBe(PING_SHOWN_BYTES);
    expect(PING_SHOWN_BYTES).toBe(7);
    expect(decode(buf)).toEqual({ type: MSG.PING_SHOWN, playerId: 4, intent: 1, x: 5999, y: 0 });
  });

  it('une intention hors liste passe le fil telle quelle : c est le salon qui la refuse', () => {
    expect(decode(encodePing(200, 0, 0))).toMatchObject({ intent: 200 });
  });

  it('un PING tronque leve, il ne se decode jamais a moitie', () => {
    expect(() => decode(encodePing(0, 1, 1).slice(0, 5))).toThrow(/tronque/);
  });
});

/** Un `PlayerSnapshot` complet, pour ne poser que le champ qu'un test de bouclier fait varier. */
function unJoueur(overrides: Partial<PlayerSnapshot> & { id: number }): PlayerSnapshot {
  return { x: 0, y: 0, hp: 1, aimX: 0, aimY: 0, pickupRadius: 90, shield: 0, ...overrides };
}

describe('etape 13 : le bouclier sur le fil', () => {
  it('un octet de plus par joueur, pas deux', () => {
    expect(SNAPSHOT_PLAYER_BYTES).toBe(11);
  });

  it('aller-retour, et borne a 255', () => {
    const buf = encodeSnapshot(7, 0, 0, [unJoueur({ id: 1, shield: 42 })], null, 0);
    expect(decodeSnapshot(buf).players[0]?.shield).toBe(42);
    const haut = encodeSnapshot(7, 0, 0, [unJoueur({ id: 1, shield: 9999 })], null, 0);
    expect(decodeSnapshot(haut).players[0]?.shield).toBe(255);
  });
});
