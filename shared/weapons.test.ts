import { describe, expect, it } from 'vitest';

import { TICK_HZ } from './constants';
import { salvoCount, WEAPONS, weaponOf } from './weapons';

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
    }
  });

  it('place l arme neutre de base en premiere position', () => {
    expect(WEAPONS[0]?.name).toBe('dague');
  });

  it('cable au moins une arme a plusieurs projectiles, pour prouver que la forme tient', () => {
    expect(WEAPONS.some((w) => w.projectileCount > 1)).toBe(true);
  });
});

/**
 * `salvoCount` : la ou « l'accumulation des cartes fait la puissance » devient
 * un nombre. C'est la SEULE fonction qui traduit des exemplaires empiles en
 * projectiles — `Room#fireOne` et le miroir client la lisent tous les deux,
 * jamais une copie.
 */
describe('salvoCount', () => {
  /** `eventail` : cinq projectiles de base. Un compte de base different de 1 est ce qui prouve qu'il est LU. */
  const EVENTAIL = 1;
  /** `arc-lourd` : un seul projectile de base. */
  const ARC_LOURD = 2;

  it('rend le compte de base tant qu on ne possede qu un exemplaire', () => {
    // ⚠️ Un exemplaire n'elargit RIEN : c'est le deuxieme qui ajoute le
    // premier projectile. Sans ce cas, une implementation en
    // `projectileCount + stacks` passerait les tests d empilement ci-dessous
    // par simple decalage.
    for (const w of WEAPONS) {
      expect(salvoCount(w, 1)).toBe(w.projectileCount);
    }
  });

  it("rend aussi le compte de base a zero exemplaire : l'arme neutre passe par le meme chemin", () => {
    // L'arme neutre du §6.1 ne figure dans aucun `Loadout`, donc son nombre
    // d'exemplaires vaut toujours zero. Sans le `Math.max(0, ...)`, elle
    // tirerait un projectile de MOINS que le catalogue n'en annonce.
    for (const w of WEAPONS) {
      expect(salvoCount(w, 0)).toBe(w.projectileCount);
    }
  });

  it('ajoute UN projectile par exemplaire au-dela du premier', () => {
    const eventail = weaponOf(EVENTAIL);
    const arc = weaponOf(ARC_LOURD);
    // ⚠️ Deux armes aux comptes de base differents (5 et 1), et on verifie la
    // valeur ABSOLUE, pas seulement la croissance : un `stacks` qui
    // remplacerait `projectileCount` au lieu de s'y ajouter ferait croitre la
    // salve tout autant, en oubliant l'arme.
    expect(eventail.projectileCount).toBe(5);
    expect(salvoCount(eventail, 2)).toBe(6);
    expect(salvoCount(eventail, 3)).toBe(7);

    expect(arc.projectileCount).toBe(1);
    expect(salvoCount(arc, 2)).toBe(2);
    expect(salvoCount(arc, 3)).toBe(3);
  });

  it('croit strictement de un a chaque exemplaire supplementaire, sur tout le catalogue', () => {
    for (const w of WEAPONS) {
      for (let stacks = 1; stacks <= 12; stacks++) {
        expect(salvoCount(w, stacks + 1) - salvoCount(w, stacks)).toBe(1);
      }
    }
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
