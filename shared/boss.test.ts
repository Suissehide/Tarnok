import { describe, expect, it } from 'vitest';

import { BOSS_BODY_SCALE } from './archetypes';
import {
  BOSS_CHARGE_COOLDOWN_TICKS,
  BOSS_CHARGE_LENGTH_PX,
  BOSS_CHARGE_TICKS,
  BOSS_CHARGE_WIDTH_PX,
  BOSS_CHARGE_WINDUP_TICKS,
  type BossCharge,
  chargeHoldsAt,
  chargeHurtsAt,
  chargePointAt,
  chargeProgressAt,
  makeBossCharge,
} from './boss';
import { PROJECTILE_HIT_RADIUS } from './constants';

const BOSS_ID = 8193;
const ANNOUNCE = 500;

/** Une charge vers l'est, annoncee au tick `ANNOUNCE` depuis (1000, 2000). */
function charge(): BossCharge {
  return makeBossCharge(BOSS_ID, 1000, 2000, 4000, 2000, ANNOUNCE);
}

describe('la charge du boss : une valeur, et des fonctions du tick', () => {
  it('fige la direction au chargement, vers la cible visee', () => {
    const c = charge();
    expect(c.dirX).toBe(1);
    expect(c.dirY).toBe(0);
    expect(c.x).toBe(1000);
    expect(c.y).toBe(2000);
  });

  /**
   * ⚠️ **Le couloir vise, mais il ne SUIT pas.** C'est ce qui rend l'esquive
   * possible : un couloir qui suivrait sa cible serait une taxe, pas une
   * attaque. Le test le dit de la seule facon qui compte — la valeur ne porte
   * aucune cible, donc rien dans le reste du fichier ne peut la relire.
   */
  it('ne retient aucune cible : rien ne peut plus la recorriger', () => {
    expect(Object.keys(charge()).sort()).toEqual([
      'dirX',
      'dirY',
      'endTick',
      'entityId',
      'length',
      'startTick',
      'width',
      'windupTick',
      'x',
      'y',
    ]);
  });

  it('date le depart apres le chargement, et la fin apres la traversee', () => {
    const c = charge();
    expect(c.windupTick).toBe(ANNOUNCE);
    expect(c.startTick).toBe(ANNOUNCE + BOSS_CHARGE_WINDUP_TICKS);
    expect(c.endTick).toBe(c.startTick + BOSS_CHARGE_TICKS);
  });

  it('porte la longueur et la largeur du couloir, la largeur etant celle du corps', () => {
    const c = charge();
    expect(c.length).toBe(BOSS_CHARGE_LENGTH_PX);
    // La constante n'est pas recopiee : elle est DERIVEE de la hitbox du boss,
    // et c'est cette derivation-la qu'on garde — voir `BOSS_CHARGE_WIDTH_PX`.
    expect(c.width).toBe(2 * PROJECTILE_HIT_RADIUS * BOSS_BODY_SCALE);
  });

  it('normalise la direction, quel que soit l eloignement de la cible', () => {
    const proche = makeBossCharge(BOSS_ID, 0, 0, 30, 40, 0);
    const loin = makeBossCharge(BOSS_ID, 0, 0, 3000, 4000, 0);
    expect(proche.dirX).toBeCloseTo(0.6, 4);
    expect(proche.dirY).toBeCloseTo(0.8, 4);
    expect(loin.dirX).toBe(proche.dirX);
    expect(loin.dirY).toBe(proche.dirY);
  });

  it('choisit une direction par defaut quand la cible est confondue avec l origine', () => {
    const c = makeBossCharge(BOSS_ID, 700, 700, 700, 700, 0);
    expect(c.dirX).toBe(1);
    expect(c.dirY).toBe(0);
  });

  /**
   * ⚠️ **La position se DERIVE des ticks, et de rien d'autre.** C'est toute la
   * parade : zero octet apres l'annonce, meme position partout, par
   * construction.
   */
  it('tient le boss immobile a l origine pendant tout le chargement', () => {
    const c = charge();
    const out = new Float32Array(2);
    for (let t = c.windupTick; t <= c.startTick; t++) {
      chargePointAt(c, t, out);
      expect(chargeProgressAt(c, t), `tick ${t}`).toBe(0);
      expect(out[0], `tick ${t}`).toBe(c.x);
      expect(out[1], `tick ${t}`).toBe(c.y);
    }
  });

  it('avance le long du couloir, strictement, jusqu au bout exactement', () => {
    const c = charge();
    const out = new Float32Array(2);
    let previous = -1;
    for (let t = c.startTick; t <= c.endTick; t++) {
      chargePointAt(c, t, out);
      expect(out[0] ?? 0, `tick ${t}`).toBeGreaterThan(previous);
      previous = out[0] ?? 0;
      // Le couloir est droit : l'axe transverse ne bouge jamais.
      expect(out[1], `tick ${t}`).toBe(c.y);
    }
    expect(previous).toBeCloseTo(c.x + c.length, 3);
  });

  it('borne la progression aux deux bouts', () => {
    const c = charge();
    expect(chargeProgressAt(c, c.windupTick - 100)).toBe(0);
    expect(chargeProgressAt(c, c.endTick + 100)).toBe(1);
    expect(chargeProgressAt(c, (c.startTick + c.endTick) / 2)).toBeCloseTo(0.5, 6);
  });

  it('pilote la position du chargement a la fin de la traversee, et pas au-dela', () => {
    const c = charge();
    expect(chargeHoldsAt(c, c.windupTick - 1)).toBe(false);
    expect(chargeHoldsAt(c, c.windupTick)).toBe(true);
    expect(chargeHoldsAt(c, c.startTick)).toBe(true);
    expect(chargeHoldsAt(c, c.endTick)).toBe(true);
    expect(chargeHoldsAt(c, c.endTick + 1)).toBe(false);
  });

  /**
   * ⚠️ **RIEN NE FAIT MAL PENDANT LE CHARGEMENT.** C'est ce qui rend le
   * telegraphe sur, et c'est ce qui donne au joueur sa fenetre de reaction : le
   * temps de chargement EST cette fenetre. La borne basse est stricte — au tick
   * du depart, le corps n'a pas encore bouge d'un pixel.
   */
  it('ne fait mal a AUCUN tick du chargement, ni au tick du depart', () => {
    const c = charge();
    for (let t = c.windupTick; t <= c.startTick; t++) {
      expect(chargeHurtsAt(c, t), `tick ${t}`).toBe(false);
    }
    expect(chargeHurtsAt(c, c.startTick + 1)).toBe(true);
    expect(chargeHurtsAt(c, c.endTick)).toBe(true);
    expect(chargeHurtsAt(c, c.endTick + 1)).toBe(false);
  });

  /**
   * La moitie haute du couple : sans elle, un `chargeHurtsAt` qui rendrait
   * toujours `false` passerait le test precedent et la charge ne toucherait
   * jamais personne.
   */
  it('fait mal a chaque tick de la traversee ou le corps bouge', () => {
    const c = charge();
    const hurting: number[] = [];
    for (let t = c.windupTick; t <= c.endTick + 1; t++) {
      if (chargeHurtsAt(c, t)) {
        hurting.push(t);
      }
    }
    expect(hurting).toHaveLength(BOSS_CHARGE_TICKS);
  });

  it('rend la meme position pour le meme tick, appelee deux fois', () => {
    // Le socle de la replication : la fonction est PURE, elle ne tient aucun
    // etat entre deux appels — deux cotes du fil peuvent l'appeler dans
    // n'importe quel ordre.
    const c = charge();
    const a = new Float32Array(2);
    const b = new Float32Array(2);
    chargePointAt(c, c.endTick, a);
    chargePointAt(c, c.startTick + 3, b);
    chargePointAt(c, c.endTick, b);
    expect([...b]).toEqual([...a]);
  });

  /**
   * ⚠️ **Cette propriete PORTE une suppression de code.** `Room#stepBossCharge`
   * n'a plus qu'une garde pour decider qu'une nouvelle charge peut s'annoncer —
   * `tick >= #nextChargeTick`, qui vaut `endTick + BOSS_CHARGE_COOLDOWN_TICKS`.
   * Elle ne couvre la charge en cours que si ce delai est **non nul** ; a zero,
   * une seconde charge pourrait s'annoncer au tick meme ou la premiere finit,
   * et deux couloirs se disputeraient la position d'un seul boss. Le delai est
   * un REGLAGE que la tache 12 va bouger : c'est donc ici, sur la propriete, que
   * la borne se garde — jamais par une valeur recopiee.
   */
  it('separe deux charges par un delai NON NUL — la propriete qui autorise une seule garde', () => {
    expect(BOSS_CHARGE_COOLDOWN_TICKS).toBeGreaterThan(0);
  });

  it('couvre la meme largeur que le corps qui la traverse', () => {
    expect(BOSS_CHARGE_WIDTH_PX).toBeGreaterThan(0);
    expect(charge().width).toBe(BOSS_CHARGE_WIDTH_PX);
  });
});
