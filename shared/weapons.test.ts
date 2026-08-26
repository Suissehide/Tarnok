import { describe, expect, it } from 'vitest';

import { TICK_HZ } from './constants';
import { passiveOf } from './passives';
import { WEAPONS, weaponOf } from './weapons';

describe('WEAPONS', () => {
  it('indexe chaque arme a sa position dans le tableau', () => {
    WEAPONS.forEach((w, i) => {
      expect(w.id).toBe(i);
    });
  });

  it('compte entre huit et dix armes', () => {
    expect(WEAPONS.length).toBeGreaterThanOrEqual(8);
    expect(WEAPONS.length).toBeLessThanOrEqual(10);
  });

  it('donne des valeurs strictement positives a chaque arme', () => {
    for (const w of WEAPONS) {
      expect(w.cooldownTicks).toBeGreaterThan(0);
      expect(w.damage).toBeGreaterThan(0);
      expect(w.projectileSpeed).toBeGreaterThan(0);
      expect(w.projectileLifeTicks).toBeGreaterThan(0);
      expect(w.projectileCount).toBeGreaterThan(0);
      expect(w.spreadRadians).toBeGreaterThan(0);
      expect(w.maxLevel).toBeGreaterThan(0);
    }
  });

  it('place l arme neutre de base en premiere position', () => {
    expect(WEAPONS[0]?.name).toBe('dague');
  });

  it('cable au moins une arme a plusieurs projectiles, pour prouver que la forme tient', () => {
    expect(WEAPONS.some((w) => w.projectileCount > 1)).toBe(true);
  });
});

describe('evolutionPassiveId', () => {
  it('vaut -1, ou designe un passif existant', () => {
    for (const w of WEAPONS) {
      if (w.evolutionPassiveId === -1) {
        continue;
      }
      expect(() => passiveOf(w.evolutionPassiveId)).not.toThrow();
    }
  });

  it('cable au moins une arme qui evolue, sinon cette nature de carte ne serait jamais testee', () => {
    expect(WEAPONS.some((w) => w.evolutionPassiveId !== -1)).toBe(true);
  });
});

/**
 * Tache 16, etape 3 : « les tirs ne sont pas infini en distance » — 333 px
 * (la portee d'AVANT la tache 14, qui l'a portee a 650 * 28 / 30 ≈ 606,7 px,
 * voir `WEAPON_DEFS[0]` ci-dessus) faisaient un cinquieme d'un ecran mesure a
 * 1728 px. Ce chiffre du brief est donc perime sur le code actuel — mais la
 * demande reste valide : viser une FRACTION d'ecran plutot qu'un ressenti, et
 * proteger ce choix par un test plutot que par la seule lecture du chiffre
 * dans un commentaire.
 */
describe('portee du tir (tache 16, etape 3)', () => {
  /**
   * Repere de conception, pas une constante d'execution : la vue se
   * redimensionne a la fenetre (`resizeTo: parent`, `front/src/render/stage.ts`),
   * rien dans le code ne fixe de largeur d'ecran. 1728 px est la largeur
   * mesuree par l'auteur en jouant (brief de la tache 16) — une resolution de
   * calibrage courante (MacBook Pro 16", en points), pas un contrat
   * technique. Un test qui la reference documente l'intention de reglage sans
   * pretendre qu'elle est garantie a l'execution.
   */
  const REFERENCE_VIEWPORT_PX = 1728;

  /**
   * Bande visee, exprimee en fraction de `REFERENCE_VIEWPORT_PX` :
   * - en dessous de 25 %, on retombe pres du defaut signale par le brief
   *   (l'ancienne portee de 333 px faisait 19,3 % de 1728 px) ;
   * - au-dessus de 50 %, la portee couvrirait plus de la moitie de l'ecran, ce
   *   qui videe la notion meme de « portee limitee » a vue.
   */
  const MIN_VIEWPORT_FRACTION = 0.25;
  const MAX_VIEWPORT_FRACTION = 0.5;

  it("la portee de l'arme neutre de base reste une fraction lisible d'un ecran de reference", () => {
    const dague = weaponOf(0);
    const rangePx = (dague.projectileSpeed * dague.projectileLifeTicks) / TICK_HZ;
    const fraction = rangePx / REFERENCE_VIEWPORT_PX;

    expect(fraction).toBeGreaterThanOrEqual(MIN_VIEWPORT_FRACTION);
    expect(fraction).toBeLessThanOrEqual(MAX_VIEWPORT_FRACTION);
  });
});

describe('weaponOf', () => {
  it('rend l arme portant cet identifiant', () => {
    expect(weaponOf(0)?.name).toBe(WEAPONS[0]?.name);
  });

  it('leve sur un identifiant inconnu plutot que de rendre undefined', () => {
    expect(() => weaponOf(99)).toThrow(/inconnu/i);
  });
});
