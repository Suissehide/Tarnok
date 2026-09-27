import { describe, expect, it } from 'vitest';

import { TICK_HZ } from './constants';
import { ELEMENT, elementOf } from './elements';
import { PASSIVES } from './passives';
import {
  assertWeaponElements,
  assertWeaponLooks,
  BASE_WEAPON_ID,
  cooldownWithBonus,
  MAX_FIRE_RATE_BONUS,
  PROJECTILE_FADE_REFERENCE_TICKS,
  projectileAlpha,
  projectileTrailPx,
  salvoCount,
  WEAPONS,
  weaponOf,
} from './weapons';

describe('WEAPONS', () => {
  it('indexe chaque arme a sa position dans le tableau', () => {
    WEAPONS.forEach((w, i) => {
      expect(w.id).toBe(i);
    });
  });

  /**
   * ⚠️ **Dix-sept depuis la tache 8 de l'etape 5c** : neuf a l'etape 5a (deux
   * Braise, deux Givre, cinq neutres), plus deux Foudre et deux Poix a la
   * tache 9 de l'etape 5b, plus deux Chaux et deux Vif-argent ici. La borne
   * haute reste loin du pool de quarante du §6.2 — cette tache ne visait que
   * le cablage minimal (deux armes par nouvel element), pas le pool complet.
   */
  it('compte entre seize et dix-huit armes', () => {
    expect(WEAPONS.length).toBeGreaterThanOrEqual(16);
    expect(WEAPONS.length).toBeLessThanOrEqual(18);
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

  /**
   * L'apparence (etape 5a, tache 12). ⚠️ **`trailTicks <= projectileLifeTicks`**
   * n'est pas de la coquetterie : une trainee plus longue que le vol entier
   * dessinerait le projectile derriere son propre point de depart.
   */
  it('donne a chaque arme une apparence aux valeurs tenables', () => {
    for (const w of WEAPONS) {
      expect(w.look.diameterPx, w.name).toBeGreaterThan(0);
      expect(w.look.glow, w.name).toBeGreaterThanOrEqual(0);
      expect(w.look.glow, w.name).toBeLessThanOrEqual(1);
      expect(w.look.trailTicks, w.name).toBeGreaterThan(0);
      expect(w.look.trailTicks, w.name).toBeLessThanOrEqual(w.projectileLifeTicks);
    }
  });

  it('place l arme neutre de base en premiere position', () => {
    expect(WEAPONS[0]?.name).toBe('dague');
  });

  it('cable au moins une arme a plusieurs projectiles, pour prouver que la forme tient', () => {
    expect(WEAPONS.some((w) => w.projectileCount > 1)).toBe(true);
  });

  /**
   * L'autre extreme de la cadence (etape 6a, tache 19).
   *
   * ⚠️ **L'arme la plus rapide n'est PAS l'arme de base, et c'est ce qui a
   * borne la main a la tache 19.** Accelerer tout du meme facteur amenait la
   * dague a 4 ticks et le lance-flammes a 3 ; les deux valeurs ont ete posees a
   * la main precisement pour que la dague ne devienne pas l'arme la plus rapide
   * du catalogue. Une dague plus rapide que le lance-flammes retirerait a
   * celui-ci sa seule raison d'exister — *« cadence tres rapide, courte
   * portee »* — et rendrait l'arme gratuite meilleure que la carte.
   */
  it("l'arme la plus rapide est unique, et ce n'est jamais l'arme de base", () => {
    const cadenceMin = Math.min(...WEAPONS.map((w) => w.cooldownTicks));
    expect(WEAPONS.filter((w) => w.cooldownTicks === cadenceMin).length).toBe(1);
    expect(weaponOf(BASE_WEAPON_ID).cooldownTicks).toBeGreaterThan(cadenceMin);
  });

  /**
   * ⚠️ **LE garde-fou de la tache 19, et il porte sur le PASSIF, pas sur les
   * armes.** `cooldownWithBonus` arrondit et plafonne : plus une arme est
   * rapide, moins il reste de marches a la carte « cadence » avant qu'elle ne
   * change plus rien. A 4 ticks le passif garde huit cartes utiles ; a 2 ticks
   * il n'en garde plus que quatre, et *« le passif cesserait de servir »*.
   * C'est ce qui a arrete l'acceleration au facteur 0,60 alors que le banc
   * continuait de rendre un peu plus de morts en dessous.
   *
   * Six cartes du meme passif, c'est deja six montees de niveau depensees sur
   * une seule ligne — au-dela, plus rien ne se joue de toute facon (le plafond
   * `MAX_FIRE_RATE_BONUS` mord vers la dixieme).
   */
  it('laisse au moins six cartes de cadence utiles sur chaque arme', () => {
    const cadence = PASSIVES.find((p) => p.kind === 'fireRate');
    expect(cadence).toBeDefined();
    const magnitude = cadence?.magnitude ?? 0;
    expect(magnitude).toBeGreaterThan(0);
    // La derniere carte qui puisse encore compter : au-dela, le plafond fige
    // la recharge quoi qu'on prenne.
    const plancher = (base: number): number => cooldownWithBonus(base, MAX_FIRE_RATE_BONUS);

    for (const w of WEAPONS) {
      const minimum = plancher(w.cooldownTicks);
      let utiles = 0;
      // Le nombre de cartes qu'il faut pour atteindre le minimum : au-dela, la
      // carte suivante ne retire plus rien.
      for (
        let cartes = 0;
        cooldownWithBonus(w.cooldownTicks, magnitude * cartes) > minimum;
        cartes++
      ) {
        utiles = cartes + 1;
      }
      expect(utiles, `arme « ${w.name} » (${w.cooldownTicks} ticks)`).toBeGreaterThanOrEqual(6);
    }
  });
});

describe("l'element porte par une arme (etape 5a)", () => {
  /**
   * §4.2 : *« deux passent en Braise, deux en Givre, les cinq autres restent
   * neutres »*, etendu par la tache 9 de l'etape 5b (deux de plus en Foudre,
   * deux de plus en Poix) puis par la tache 8 de l'etape 5c (deux de plus en
   * Chaux, deux de plus en Vif-argent) — le compte de neutres ne bouge pas a
   * chaque fois. Compter, plutot que de faire confiance a la lecture de la
   * table : c'est le seul endroit ou une arme elementaire oubliee ou ajoutee
   * en trop se voit — plus loin dans l'etape, elle se contenterait de ne pas
   * poser de zone.
   */
  it('cable exactement deux armes par element, et laisse les autres neutres', () => {
    const compte = (element: number) => WEAPONS.filter((w) => w.element === element).length;

    expect(compte(ELEMENT.BRAISE)).toBe(2);
    expect(compte(ELEMENT.GIVRE)).toBe(2);
    expect(compte(ELEMENT.FOUDRE)).toBe(2);
    expect(compte(ELEMENT.POIX)).toBe(2);
    expect(compte(ELEMENT.CHAUX)).toBe(2);
    expect(compte(ELEMENT.VIF_ARGENT)).toBe(2);
    expect(compte(ELEMENT.NEUTRE)).toBe(WEAPONS.length - 12);
  });

  /**
   * ⚠️ **L'arme de base reste neutre, et ce n'est pas un oubli.** Le §6.3 de
   * l'orientation en fait *« un socle pour les joueurs qui ne veulent pas
   * jouer le systeme »* : elle est la seule arme que tout le monde porte a
   * chaque tick, donc lui donner un element marquerait la horde entiere en
   * permanence et rendrait le systeme elementaire subi plutot que choisi.
   */
  it('laisse neutre l arme de base, avec laquelle toute run commence', () => {
    expect(weaponOf(BASE_WEAPON_ID).element).toBe(ELEMENT.NEUTRE);
  });

  /**
   * L'omission vaut `NEUTRE` (§4.2) : c'est la ligne ABSENTE qui est le cas
   * courant dans `WEAPON_DEFS`. Sans ce test, un defaut mal ecrit rendrait
   * `undefined` — et `undefined` n'est ni un element ni une erreur, il
   * traverserait tout le systeme en ne marquant jamais rien.
   */
  it('donne un element defini a chaque arme, meme a celles qui ne le declarent pas', () => {
    for (const w of WEAPONS) {
      expect(typeof w.element, `arme « ${w.name} »`).toBe('number');
    }
  });
});

/**
 * Les armes de zone (etape 6a, tache 16) — *« il faut parfois des AoE sur
 * certaines armes comme les grenades »*.
 */
describe('le rayon de zone porte par une arme (tache 16)', () => {
  /**
   * Meme raison que pour `element` : l'omission vaut `0`, et `undefined`
   * n'est ni un rayon ni une erreur — il traverserait `Projectiles` jusqu'a
   * `damageInRadius`, ou `undefined > 0` est faux, donc une arme de zone
   * cesserait d'exploser en silence.
   */
  it('donne un rayon defini et jamais negatif a chaque arme, declare ou non', () => {
    for (const w of WEAPONS) {
      expect(typeof w.blastRadius, `arme « ${w.name} »`).toBe('number');
      expect(w.blastRadius, `arme « ${w.name} »`).toBeGreaterThanOrEqual(0);
    }
  });

  /**
   * ⚠️ **Garde par une PROPRIETE, pas par un nom ni par un chiffre.** « La
   * grenade explose » se verifierait avec `weaponOf(4)`, et ce test survivrait
   * a une reindexation du catalogue en mesurant autre chose. Ce que la tache
   * demande, c'est que l'arme de zone soit *l'arme dont le tir doit peser* :
   * la cadence la plus lente ET les degats les plus eleves. Les deux, parce
   * qu'une seule des deux ne designe pas forcement la meme arme.
   */
  it("l'unique arme de zone est celle qui frappe le plus fort et le plus lentement", () => {
    const zone = WEAPONS.filter((w) => w.blastRadius > 0);
    expect(zone.length).toBe(1);

    const cadenceMax = Math.max(...WEAPONS.map((w) => w.cooldownTicks));
    const degatsMax = Math.max(...WEAPONS.map((w) => w.damage));
    expect(zone[0]?.cooldownTicks).toBe(cadenceMax);
    expect(zone[0]?.damage).toBe(degatsMax);

    // Non-vacuite : ces deux extremes designent bien UNE arme, pas huit ex
    // aequo. Sans ca, un catalogue plat rendrait le test ci-dessus toujours
    // vrai.
    expect(WEAPONS.filter((w) => w.cooldownTicks === cadenceMax).length).toBe(1);
    expect(WEAPONS.filter((w) => w.damage === degatsMax).length).toBe(1);
  });

  /**
   * ⚠️ **Le rayon de zone n'a RIEN a voir avec la taille dessinee.** Le
   * premier decide de ce qui meurt, le second de ce qui se voit. Les tenir
   * distincts est ce qui empeche de regler l'equilibrage a l'oeil — meme
   * raison que `spriteScale` et `zoneScale`, dont la taille de texture doit
   * rester differente de la taille affichee.
   */
  it('ne confond pas le rayon de zone avec le diametre dessine du projectile', () => {
    for (const w of WEAPONS) {
      if (w.blastRadius > 0) {
        expect(w.blastRadius, `arme « ${w.name} »`).not.toBe(w.look.diameterPx);
      }
    }
  });
});

/**
 * La garde de chargement du module. Elle prend la table en parametre pour
 * qu'un test puisse lui en donner une cassee : le vrai catalogue est une
 * constante, aucun test ne peut y glisser une reference morte.
 */
describe('assertWeaponElements', () => {
  it('accepte le catalogue reel', () => {
    expect(() => assertWeaponElements(WEAPONS)).not.toThrow();
  });

  it('leve sur une arme qui designe un element inexistant', () => {
    const base = weaponOf(BASE_WEAPON_ID);
    expect(() => assertWeaponElements([{ ...base, element: 99 }])).toThrow(/element inconnu/i);
  });

  /**
   * ⚠️ Le piege de la fixture qui masque, pris a l'avance : une garde qui
   * s'arreterait a la premiere arme passerait le test ci-dessus si la seule
   * arme cassee etait la premiere. La reference morte est ici la DERNIERE.
   */
  it('inspecte toute la table, pas seulement la premiere arme', () => {
    const base = weaponOf(BASE_WEAPON_ID);
    expect(() => assertWeaponElements([base, base, { ...base, element: 99 }])).toThrow(
      /element inconnu/i,
    );
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

/**
 * L'apparence des projectiles (etape 5a, tache 12), venue de l'auteur en
 * jouant : *« fais des projectiles differents pour chaque arme »*.
 *
 * ⚠️ **« Chaque arme a une apparence » et « toutes les armes ont la MEME
 * apparence » se ressemblent beaucoup dans un test faible.** D'ou la garde de
 * chargement `assertWeaponLooks`, et d'ou le fait que ces cas lui donnent des
 * tables VOLONTAIREMENT cassees : le vrai catalogue est une constante, aucun
 * test ne peut y glisser un doublon.
 */
describe('assertWeaponLooks — chaque arme, son apparence', () => {
  const base = weaponOf(BASE_WEAPON_ID);
  const avecTeinte = (name: string, tint: number, element: number = ELEMENT.NEUTRE) => ({
    ...base,
    name,
    element,
    look: { ...base.look, tint },
  });

  it('accepte le catalogue reel', () => {
    expect(() => assertWeaponLooks(WEAPONS)).not.toThrow();
  });

  it('leve quand une arme reprend la teinte de son element', () => {
    // L'element se lit a la zone au sol et a la marque, jamais au projectile.
    expect(() =>
      assertWeaponLooks([avecTeinte('braisette', elementOf(ELEMENT.BRAISE).tint, ELEMENT.BRAISE)]),
    ).toThrow(/identique a celle de son element/i);
  });

  it('leve quand deux armes partagent une teinte', () => {
    expect(() => assertWeaponLooks([avecTeinte('a', 0x123456), avecTeinte('b', 0x123456)])).toThrow(
      /meme teinte/i,
    );
  });

  /**
   * ⚠️ Le piege de la fixture qui masque, pris a l'avance — comme pour
   * `assertWeaponElements` : une garde qui s'arreterait a la premiere arme
   * passerait les deux cas ci-dessus. Le defaut est ici en DERNIERE position,
   * pour les deux regles.
   */
  it('inspecte toute la table, pas seulement la premiere arme', () => {
    expect(() =>
      assertWeaponLooks([
        avecTeinte('a', 0x111111),
        avecTeinte('b', 0x222222),
        avecTeinte('c', 0x111111),
      ]),
    ).toThrow(/meme teinte/i);

    expect(() =>
      assertWeaponLooks([
        avecTeinte('a', 0x111111),
        avecTeinte('b', 0x222222),
        avecTeinte('givree', elementOf(ELEMENT.GIVRE).tint, ELEMENT.GIVRE),
      ]),
    ).toThrow(/identique a celle de son element/i);
  });

  /**
   * La moitie « et le catalogue reel, alors ? » : la garde ci-dessus protege
   * l'AVENIR, ce cas mesure le PRESENT. Les deux armes de chaque element sont
   * explicitement confrontees — Foudre et Poix ont rejoint Braise et Givre a
   * la tache 9 de l'etape 5b, Chaux et Vif-argent les rejoignent ici.
   */
  it('donne a chaque arme du catalogue une teinte deux a deux distincte des autres', () => {
    expect(new Set(WEAPONS.map((w) => w.look.tint)).size).toBe(WEAPONS.length);

    const parElement = (element: number) => WEAPONS.filter((w) => w.element === element);
    for (const element of [
      ELEMENT.BRAISE,
      ELEMENT.GIVRE,
      ELEMENT.FOUDRE,
      ELEMENT.POIX,
      ELEMENT.CHAUX,
      ELEMENT.VIF_ARGENT,
    ]) {
      const [a, b] = parElement(element);
      expect(a?.look.tint).not.toBe(b?.look.tint);
      expect(a?.look.tint).not.toBe(elementOf(element).tint);
      expect(b?.look.tint).not.toBe(elementOf(element).tint);
    }
  });
});

/**
 * Le fondu de fin de vie, DERIVE de `projectileLifeTicks` (etape 5a, tache
 * 12) : *« fais-les durer plus longtemps ou fade pour les armes courte portee
 * comme le lance-flammes »*.
 *
 * ⚠️ **Les deux moities, toujours** (R24/R25) : une fonction qui rendrait
 * toujours 1 passerait tous les cas de l'arc-lourd, et une qui s'eteindrait
 * toujours passerait tous ceux du lance-flammes. Il faut les deux, et il faut
 * qu'ils DIFFERENT au meme age relatif.
 */
describe('projectileAlpha — la portee se voit', () => {
  const LANCE_FLAMMES = 3;
  const ARC_LOURD = 2;

  it('part a pleine opacite, pour chaque arme du catalogue', () => {
    for (const w of WEAPONS) {
      expect(projectileAlpha(w.projectileLifeTicks, w.projectileLifeTicks), w.name).toBe(1);
    }
  });

  it('laisse l arc-lourd filer NET : il ne s eteint a aucun moment de sa course', () => {
    const arc = weaponOf(ARC_LOURD);
    // La RAISON, ecrite plutot que laissee en commentaire : sa portee atteint
    // la reference, donc son fondu vaut exactement zero.
    expect(arc.projectileLifeTicks).toBeGreaterThanOrEqual(PROJECTILE_FADE_REFERENCE_TICKS);
    for (let restant = arc.projectileLifeTicks; restant >= 0; restant--) {
      expect(projectileAlpha(arc.projectileLifeTicks, restant), `restant=${restant}`).toBe(1);
    }
  });

  it('eteint le lance-flammes EN VOL, jusqu a zero', () => {
    const flammes = weaponOf(LANCE_FLAMMES);
    const vie = flammes.projectileLifeTicks;

    // Il vit 10 ticks et son fondu couvre les 75 % derniers : des le 8e tick
    // restant, il a deja commence a s'eteindre.
    expect(projectileAlpha(vie, 7)).toBeLessThan(1);
    expect(projectileAlpha(vie, 0)).toBe(0);
  });

  it('separe les deux : au MEME age relatif, le lance-flammes est plus eteint que l arc-lourd', () => {
    const flammes = weaponOf(LANCE_FLAMMES);
    const arc = weaponOf(ARC_LOURD);
    // Mi-course pour l'un comme pour l'autre.
    const aMiVie = (w: (typeof WEAPONS)[number]) =>
      projectileAlpha(w.projectileLifeTicks, w.projectileLifeTicks / 2);

    expect(aMiVie(flammes)).toBeLessThan(aMiVie(arc));
    expect(aMiVie(arc)).toBe(1);
  });

  it('n eteint jamais plus une longue portee qu une courte, sur tout le catalogue', () => {
    // La regle qui rend la table lisible : le fondu croit quand la portee
    // decroit, sans exception ni cas particulier a retenir.
    const aMiVie = WEAPONS.map((w) => ({
      name: w.name,
      vie: w.projectileLifeTicks,
      alpha: projectileAlpha(w.projectileLifeTicks, w.projectileLifeTicks / 2),
    }));
    for (const a of aMiVie) {
      for (const b of aMiVie) {
        if (a.vie < b.vie) {
          expect(a.alpha, `${a.name} vs ${b.name}`).toBeLessThanOrEqual(b.alpha);
        }
      }
    }
    // ...et la relation n'est pas vide : au moins deux valeurs differentes.
    expect(new Set(aMiVie.map((a) => a.alpha)).size).toBeGreaterThan(1);
  });

  it('ne rend ni NaN ni negatif sur une duree de vie degeneree', () => {
    expect(projectileAlpha(0, 0)).toBe(1);
    expect(projectileAlpha(10, -5)).toBe(0);
  });
});

/**
 * La trainee est une DISTANCE reellement parcourue, pas un nombre de pixels
 * choisi a cote de `projectileSpeed` — meme discipline que `zoneScale` et
 * `spriteScale`.
 */
describe('projectileTrailPx', () => {
  it('rend les ticks de trainee convertis a la vitesse de l arme', () => {
    const arc = weaponOf(2);
    // Valeur ABSOLUE, pas seulement un ordre : 900 px/s pendant 1,6 tick a
    // 30 Hz. Un `trailTicks` ignore, ou un `TICK_HZ` oublie, rendrait un autre
    // nombre tout en gardant l'ordre entre armes.
    expect(arc.projectileSpeed).toBe(900);
    expect(arc.look.trailTicks).toBe(1.6);
    expect(projectileTrailPx(arc)).toBeCloseTo((900 * 1.6) / TICK_HZ, 6);
  });

  it('suit la vitesse : l arme la plus lente ne traine pas comme la plus rapide', () => {
    const lent = weaponOf(3); // lance-flammes, 300 px/s
    const rapide = weaponOf(2); // arc-lourd, 900 px/s
    expect(projectileTrailPx(lent)).toBeLessThan(projectileTrailPx(rapide));
  });
});
