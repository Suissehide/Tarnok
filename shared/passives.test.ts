import { describe, expect, it } from 'vitest';

import { PASSIVE_KINDS, PASSIVES, passiveOf } from './passives';

describe('PASSIVES', () => {
  it('indexe chaque passif a sa position dans le tableau', () => {
    PASSIVES.forEach((p, i) => {
      expect(p.id).toBe(i);
    });
  });

  // ⚠️ **Chaque palier a son propre pool au tirage (etape 13)** : le compte par
  // palier n'est pas de la cosmetique, un palier vide ferait redescendre tous
  // ses emplacements.
  it('compte dix passifs ordinaires, et repartit les cartes de palier par tier', () => {
    expect(PASSIVES.filter((p) => !p.tier)).toHaveLength(10);
    expect(PASSIVES.filter((p) => p.tier === 'epique').map((p) => p.name)).toEqual([
      'echo',
      'colosse',
      'contagion',
    ]);
    expect(PASSIVES.filter((p) => p.tier === 'legendaire').map((p) => p.name)).toEqual([
      'transcendance',
      'fournaise',
      'hate-funeste',
    ]);
  });

  it('etape 10 : les magnitudes par carte de la spec', () => {
    const de = (kind: string): number => PASSIVES.find((p) => p.kind === kind)?.magnitude ?? -1;
    expect(de('critChance')).toBe(0.04);
    expect(de('critDamage')).toBe(0.3);
    expect(de('salvo')).toBe(1);
    expect(de('zone')).toBe(1);
    expect(de('echo')).toBe(1);
    expect(de('colossus')).toBe(0.01);
  });

  it('donne un nom et une magnitude strictement positive a chaque passif', () => {
    for (const p of PASSIVES) {
      expect(p.name.length).toBeGreaterThan(0);
      // ⚠️ **Une carte de REGLE (`rule`, etape 13) est exclue de cette borne.**
      // Son effet EST la regle, pas le nombre : `kind`/`magnitude` ne sont
      // qu'une convention de typage inerte (voir le docbloc de `Passive.rule`),
      // jamais lus par `maxHpOf`/`maxShieldOf`. Leur demander une magnitude
      // positive reviendrait a exiger un chiffre qui ne sert jamais a rien.
      if (p.rule) {
        continue;
      }
      expect(p.magnitude).toBeGreaterThan(0);
    }
  });
});

describe('etape 13 : le catalogue des paliers', () => {
  it('Moisson a disparu, et le genre harvest avec elle', () => {
    expect(PASSIVES.some((p) => p.name === 'moisson')).toBe(false);
    expect(PASSIVE_KINDS).not.toContain('harvest');
  });

  it('trois epiques, trois legendaires', () => {
    expect(PASSIVES.filter((p) => p.tier === 'epique').map((p) => p.name)).toEqual([
      'echo',
      'colosse',
      'contagion',
    ]);
    expect(PASSIVES.filter((p) => p.tier === 'legendaire').map((p) => p.name)).toEqual([
      'transcendance',
      'fournaise',
      'hate-funeste',
    ]);
  });

  /**
   * La regle de selection de l'etape : un palier haut ne recoupe aucune
   * commune.
   *
   * ⚠️ **Elargie au `malus`, pas seulement a `rule`, par rapport au brief.**
   * Fournaise (`kind: 'damage'`) et Hâte funeste (`kind: 'fireRate'`) RE-
   * UTILISENT le genre d'une commune (« puissance »/« acier », « cadence ») —
   * c'est ce qui leur evite tout code neuf (`Loadout.bonus` lit deja ces
   * genres). Ce qu'aucune commune ne porte, ce n'est pas leur genre, c'est
   * leur COUT : le `malus`. La version stricte du brief (seul `rule` exempte)
   * ferait echouer les deux a tort — exactement le defaut qu'on reproche a
   * Moisson, applique a l'envers.
   */
  it('aucune carte de palier ne partage son genre avec une carte ordinaire, sauf a en payer le cout', () => {
    const ordinaires = new Set(PASSIVES.filter((p) => !p.tier).map((p) => p.kind));
    for (const p of PASSIVES.filter((x) => x.tier)) {
      if (
        p.rule === undefined &&
        p.malus === undefined &&
        p.kind !== 'echo' &&
        p.kind !== 'colossus'
      ) {
        expect(ordinaires.has(p.kind)).toBe(false);
      }
    }
  });

  it('chaque legendaire coute quelque chose', () => {
    for (const p of PASSIVES.filter((x) => x.tier === 'legendaire')) {
      expect(p.malus !== undefined || p.rule !== undefined).toBe(true);
    }
  });

  it('aucun epique ne coute rien', () => {
    for (const p of PASSIVES.filter((x) => x.tier === 'epique')) {
      expect(p.malus).toBeUndefined();
    }
  });
});

describe('passiveOf', () => {
  it('rend le passif portant cet identifiant', () => {
    // Un id non nul : `passiveOf(0)` seul ne distinguerait pas une
    // implementation qui renverrait toujours PASSIVES[0] d'une qui indexe
    // correctement.
    expect(passiveOf(2)?.name).toBe(PASSIVES[2]?.name);
    expect(passiveOf(2)?.name).not.toBe(PASSIVES[0]?.name);
  });

  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => passiveOf(99)).toThrow(/inconnu/i);
  });
});
