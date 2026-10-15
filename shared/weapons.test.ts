import { describe, expect, it } from 'vitest';

import { PLAYER_SPEED, PROJECTILE_HIT_RADIUS, TICK_HZ } from './constants';
import { ELEMENT, elementOf } from './elements';
import { PASSIVES } from './passives';
import {
  assertWeaponElements,
  assertWeaponLooks,
  BASE_WEAPON_ID,
  CALIBRE_PER_UPGRADE,
  cooldownWithBonus,
  DETONATION_RADIUS,
  effectRadius,
  GUARD_PULSE_TICKS,
  guardIsAlive,
  guardPulsesAt,
  HEAVY_BLAST_RADIUS,
  isLaunched,
  MAX_FIRE_RATE_BONUS,
  MIN_MUZZLE_SPEED,
  PIERCE_PER_UPGRADE,
  PROJECTILE_FADE_REFERENCE_TICKS,
  projectileAlpha,
  projectileTrailPx,
  salvoCount,
  stackGain,
  UPGRADE,
  upgradedWeapon,
  VELOCITY_PER_UPGRADE,
  VENOM_PER_UPGRADE,
  WEAPONS,
  type Weapon,
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
  it('compte entre seize et dix-neuf armes', () => {
    // Dix-neuf depuis la fronde a ricochets et le missile guide (cartes
    // d'arme) : deux mecaniques de trajectoire, pas un element de plus.
    expect(WEAPONS.length).toBeGreaterThanOrEqual(16);
    expect(WEAPONS.length).toBeLessThanOrEqual(19);
  });

  it('donne des valeurs strictement positives a chaque arme', () => {
    for (const w of WEAPONS) {
      expect(w.cooldownTicks).toBeGreaterThan(0);
      expect(w.damage).toBeGreaterThan(0);
      // ⚠️ **Sauf une mine, qui ne part pas** (etape 8) : `isLaunched` ecrit la
      // regle, et le cas « plancher de vitesse » plus bas en garde les deux
      // moities — ce qui part depasse le joueur, ce qui ne part pas vaut
      // exactement zero.
      if (isLaunched(w)) {
        expect(w.projectileSpeed).toBeGreaterThan(0);
      } else {
        expect(w.projectileSpeed, w.name).toBe(0);
      }
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
    expect(WEAPONS[0]?.name).toBe('Dague');
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
  it('cable AU MOINS deux armes par element, et garde un socle de neutres', () => {
    const compte = (element: number) => WEAPONS.filter((w) => w.element === element).length;

    // ⚠️ **« Au moins deux », et plus « exactement deux », depuis l'etape 8.**
    // Chaque element a besoin d'une arme qui ARROSE et d'une qui FRAPPE —
    // c'est ce que ce cas garde, et il le gardera a quarante armes (§6.2). Ce
    // qu'il ne garde plus, c'est une symetrie parfaite : le lance-flammes est
    // passe en Braise, qui en compte donc trois (l'eventail arrose, la grenade
    // frappe, le lance-flammes entretient la marque au contact). Exiger
    // l'egalite aurait voulu dire refuser toute arme elementaire de plus sans
    // en ajouter cinq autres le meme jour.
    for (const element of [
      ELEMENT.BRAISE,
      ELEMENT.GIVRE,
      ELEMENT.FOUDRE,
      ELEMENT.POIX,
      ELEMENT.CHAUX,
      ELEMENT.VIF_ARGENT,
    ]) {
      expect(compte(element), `element ${element}`).toBeGreaterThanOrEqual(2);
    }

    // Le socle neutre du §6.3 ne doit pas fondre arme par arme : quatre
    // aujourd'hui, et jamais moins de trois sans que ce cas ne le dise.
    expect(compte(ELEMENT.NEUTRE)).toBeGreaterThanOrEqual(3);
    // Non-vacuite : la somme retombe bien sur le catalogue entier.
    const total = [
      ELEMENT.NEUTRE,
      ELEMENT.BRAISE,
      ELEMENT.GIVRE,
      ELEMENT.FOUDRE,
      ELEMENT.POIX,
      ELEMENT.CHAUX,
      ELEMENT.VIF_ARGENT,
    ].reduce<number>((n, e) => n + compte(e), 0);
    expect(total).toBe(WEAPONS.length);
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
  it('la PLUS GRANDE zone est celle qui frappe le plus fort et le plus lentement', () => {
    // ⚠️ **Les armes de famille `'halo'` sont HORS de cette regle** (etape 8) :
    // leur `blastRadius` n'est pas un souffle d'impact, c'est leur PORTEE — le
    // rayon autour du porteur. Les confondre ferait dire a ce cas qu'un halo
    // doit etre plus lent que la grenade, ce qui n'a aucun sens pour une arme
    // qui ne percute rien.
    // ⚠️ **Parmi les armes LANCEES seulement** (etape 8) : une mine a un
    // souffle elle aussi, mais sa cadence n'est pas comparable a celle d'une
    // arme qu'on lance — elle attend au sol, et ce qui la fait sauter n'est pas
    // sa recharge mais l'ennemi qui s'approche.
    const zone = WEAPONS.filter((w) => w.kind === 'tir' && isLaunched(w) && w.blastRadius > 0);
    // ⚠️ **Le souffle n'est plus l'apanage d'une seule arme depuis l'etape 8**
    // (les quatre lourdes a projectile unique en ont un de contact), mais il
    // reste une EXCEPTION : la regle du catalogue est « ce coup ne touche que
    // ce qu'il percute », et c'est la ligne absente qui doit rester le cas
    // courant.
    expect(zone.length).toBeGreaterThan(0);
    expect(zone.length).toBeLessThan(WEAPONS.length / 2);

    const plusLarge = zone.reduce((a, b) => (a.blastRadius >= b.blastRadius ? a : b));
    const lancees = WEAPONS.filter(isLaunched);
    const cadenceMax = Math.max(...lancees.map((w) => w.cooldownTicks));
    const degatsMax = Math.max(...lancees.map((w) => w.damage));
    expect(plusLarge.cooldownTicks).toBe(cadenceMax);
    expect(plusLarge.damage).toBe(degatsMax);
    // Et son souffle est STRICTEMENT le plus large : sans ca, cinq armes ex
    // aequo rendraient le cas ci-dessus vrai par accident.
    expect(zone.filter((w) => w.blastRadius === plusLarge.blastRadius).length).toBe(1);

    // Non-vacuite : ces deux extremes designent bien UNE arme, pas huit ex
    // aequo. Sans ca, un catalogue plat rendrait le test ci-dessus toujours
    // vrai.
    expect(lancees.filter((w) => w.cooldownTicks === cadenceMax).length).toBe(1);
    expect(lancees.filter((w) => w.damage === degatsMax).length).toBe(1);
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
  /**
   * `canon-a-mitraille` : huit projectiles de base. Un compte different de 1
   * est ce qui prouve qu'il est LU. (La Roue de lames et ses dix lames
   * tenaient ce role jusqu'a l'etape 12, ou elle est devenue une spirale a
   * deux bras.)
   */
  const LARGE = 7;
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

  it('elargit la salve de `stackGain` par exemplaire au-dela du premier', () => {
    const large = weaponOf(LARGE);
    const arc = weaponOf(ARC_LOURD);
    // ⚠️ Deux armes aux comptes de base differents (8 et 1), et on verifie la
    // valeur ABSOLUE, pas seulement la croissance : un `stacks` qui
    // remplacerait `projectileCount` au lieu de s'y ajouter ferait croitre la
    // salve tout autant, en oubliant l'arme.
    expect(large.projectileCount).toBe(8);
    expect(stackGain(large)).toBe(3);
    expect(salvoCount(large, 2)).toBe(11);
    expect(salvoCount(large, 3)).toBe(14);

    expect(arc.projectileCount).toBe(1);
    expect(stackGain(arc)).toBe(1);
    expect(salvoCount(arc, 2)).toBe(2);
    expect(salvoCount(arc, 3)).toBe(3);
  });

  it('croit du MEME pas a chaque exemplaire supplementaire, sur tout le catalogue', () => {
    for (const w of WEAPONS) {
      for (let stacks = 1; stacks <= 12; stacks++) {
        expect(salvoCount(w, stacks + 1) - salvoCount(w, stacks), w.name).toBe(stackGain(w));
      }
    }
  });

  /**
   * Étape 8 — **l'empilement ne punit plus les armes larges.** A +1 projectile
   * par carte quelle que soit la salve de base, une arme a projectile unique
   * quadruplait ses degats a quatre cartes quand le canon-a-mitraille gagnait
   * 37 % : le classement du catalogue se retournait sur un detail de formule.
   */
  describe('stackGain — le gain suit la largeur de la salve', () => {
    it('donne au moins un projectile par carte, a toutes les armes', () => {
      for (const w of WEAPONS) {
        expect(stackGain(w), w.name).toBeGreaterThanOrEqual(1);
      }
    });

    it('rapproche les gains relatifs des armes larges de ceux des armes etroites', () => {
      const gain4 = (w: (typeof WEAPONS)[number]): number => salvoCount(w, 4) / salvoCount(w, 1);
      const large = WEAPONS.reduce((a, b) => (a.projectileCount >= b.projectileCount ? a : b));
      const etroite = WEAPONS.reduce((a, b) => (a.projectileCount <= b.projectileCount ? a : b));
      expect(large.projectileCount).toBeGreaterThan(etroite.projectileCount);
      // Avant : 1,375 contre 4. Le but n'est pas l'egalite — une arme large
      // part de plus haut — mais que l'ecart cesse d'etre un gouffre.
      expect(gain4(large)).toBeGreaterThan(2);
      expect(gain4(large)).toBeLessThan(gain4(etroite));
    });

    // Etape 12 : la Roue de lames (10 -> 2) rentre dans le rang, le Missile
    // guide (1 -> 5) en sort — toujours deux armes larges sur dix-neuf.
    it('ne touche PAS les armes a salve etroite : toutes sauf deux sont inchangees', () => {
      const inchangees = WEAPONS.filter((w) => stackGain(w) === 1);
      expect(inchangees.length).toBe(WEAPONS.length - 2);
      for (const w of inchangees) {
        expect(w.projectileCount, w.name).toBeLessThanOrEqual(3);
      }
    });
  });
});

/**
 * Le souffle de contact des armes lourdes (etape 8), et la regle qui le borne.
 */
describe('HEAVY_BLAST_RADIUS — a qui le souffle appartient', () => {
  it('n appartient qu a des armes LENTES a projectile unique', () => {
    // Une arme rapide a souffle poserait des explosions en continu — ce que le
    // §6.6 refuse exactement comme il refuse un halo permanent.
    const mediane = [...WEAPONS].sort((a, b) => a.cooldownTicks - b.cooldownTicks)[
      Math.floor(WEAPONS.length / 2)
    ];
    for (const w of WEAPONS) {
      // Hors famille `'tir'`, `blastRadius` n'est pas un souffle — voir le cas
      // « la PLUS GRANDE zone » plus haut.
      if (w.kind === 'tir' && w.blastRadius > 0) {
        expect(w.projectileCount, w.name).toBe(1);
        expect(w.cooldownTicks, w.name).toBeGreaterThanOrEqual(mediane?.cooldownTicks ?? 0);
      }
      // ⚠️ **La frappe (etape 12) est TOLEREE a plusieurs impacts**, et c'est
      // l'arme qui le veut : trois eclairs autour d'un point, chacun de ce
      // rayon. Elle reste soumise a la moitie qui compte pour le §6.6 — la
      // LENTEUR —, sans quoi ce serait l'explosion continue que la regle
      // refuse.
      if (w.kind === 'frappe') {
        expect(w.cooldownTicks, w.name).toBeGreaterThanOrEqual(mediane?.cooldownTicks ?? 0);
      }
    }
  });

  it('reste strictement sous celui de la grenade', () => {
    const tirs = WEAPONS.filter((w) => w.kind === 'tir' && isLaunched(w));
    const grenade = tirs.reduce((a, b) => (a.blastRadius >= b.blastRadius ? a : b));
    for (const w of tirs) {
      if (w.blastRadius > 0 && w !== grenade) {
        expect(w.blastRadius, w.name).toBe(HEAVY_BLAST_RADIUS);
        expect(w.blastRadius, w.name).toBeLessThan(grenade.blastRadius);
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
    // Valeur ABSOLUE, pas seulement un ordre : 600 px/s (900 avant l'etape
    // 12) pendant 1,6 tick a 30 Hz. Un `trailTicks` ignore, ou un `TICK_HZ`
    // oublie, rendrait un autre nombre tout en gardant l'ordre entre armes.
    expect(arc.projectileSpeed).toBe(600);
    expect(arc.look.trailTicks).toBe(1.6);
    expect(projectileTrailPx(arc)).toBeCloseTo((600 * 1.6) / TICK_HZ, 6);
  });

  it('suit la vitesse : l arme la plus lente ne traine pas comme la plus rapide', () => {
    const lent = weaponOf(3); // lance-flammes, 460 px/s
    const rapide = weaponOf(2); // arc-lourd, 600 px/s
    expect(projectileTrailPx(lent)).toBeLessThan(projectileTrailPx(rapide));
  });
});

/**
 * Étape 8 — **la taille dit ce que le coup pese**, venu de l'auteur en jouant :
 * *« varie les tailles et impact des projectiles, on dirait qu'ils font tous
 * pareil »*.
 *
 * Avant ce tour, les calibres etaient varies mais ARBITRAIRES : le Canon a
 * chaux (15 degats) etait le plus gros du catalogue, la Grenade (40) le
 * cinquieme. Varier n'est pas informer — un joueur ne pouvait rien deduire de
 * ce qu'il voyait partir.
 */
describe('les calibres de projectile disent les degats', () => {
  it('ne rend jamais un coup plus faible plus GROS qu un coup plus fort', () => {
    for (const a of WEAPONS) {
      for (const b of WEAPONS) {
        if (a.damage < b.damage) {
          expect(
            a.look.diameterPx,
            `« ${a.name} » (${a.damage} degats) vs « ${b.name} » (${b.damage})`,
          ).toBeLessThan(b.look.diameterPx);
        }
      }
    }
  });

  it('departage deux armes de memes degats par la CADENCE : ce qui tire vite est plus petit', () => {
    for (const a of WEAPONS) {
      for (const b of WEAPONS) {
        if (a.damage === b.damage && a.cooldownTicks < b.cooldownTicks) {
          expect(a.look.diameterPx, `« ${a.name} » vs « ${b.name} »`).toBeLessThan(
            b.look.diameterPx,
          );
        }
      }
    }
  });

  it('garde les dix-sept calibres distincts deux a deux', () => {
    expect(new Set(WEAPONS.map((w) => w.look.diameterPx)).size).toBe(WEAPONS.length);
  });
});

/**
 * Étape 8 — **le plancher de vitesse**, signale deux fois en jouant : *« quand
 * on avance dans la meme direction, les tirs sont sur moi »*, puis *« les
 * projectiles se tassent encore »*.
 */
describe('MIN_MUZZLE_SPEED — un projectile prend de l avance sur son tireur', () => {
  it('fait partir CHAQUE arme plus vite que le joueur, avec de la marge', () => {
    for (const w of WEAPONS.filter(isLaunched)) {
      expect(w.projectileSpeed, w.name).toBeGreaterThanOrEqual(MIN_MUZZLE_SPEED);
    }
    // ⚠️ **L'autre moitie de la regle** : ce qui ne part pas vaut exactement
    // zero. Entre les deux — une vitesse faible mais non nulle — il n'y a que
    // des armes qui se tassent sur leur tireur.
    for (const w of WEAPONS.filter((w) => !isLaunched(w))) {
      expect(w.projectileSpeed, w.name).toBe(0);
      // Une mine immobile qui n'emporte rien ne ferait jamais rien : c'est son
      // souffle qui la rend utile, et le detecteur de proximite de `collide`
      // qui la declenche.
      expect(w.blastRadius, w.name).toBeGreaterThan(0);
    }
  });

  it('derive ce plancher de la vitesse du joueur, jamais d un nombre choisi', () => {
    // Si `PLAYER_SPEED` monte un jour, le plancher monte avec lui et le test
    // ci-dessus designera tout seul les armes a reprendre.
    expect(MIN_MUZZLE_SPEED).toBeGreaterThan(PLAYER_SPEED);
    expect(MIN_MUZZLE_SPEED - PLAYER_SPEED).toBeGreaterThanOrEqual(200);
  });

  it('laisse a la plus lente du catalogue de quoi sortir d un corps en un tiers de seconde', () => {
    const laPlusLente = WEAPONS.filter(isLaunched).reduce((a, b) =>
      a.projectileSpeed <= b.projectileSpeed ? a : b,
    );
    const relative = laPlusLente.projectileSpeed - PLAYER_SPEED;
    // ⚠️ **Le temps qu'il faut au projectile le plus lent pour sortir du corps
    // de son tireur qui le suit** — un corps fait `2 x PROJECTILE_HIT_RADIUS`
    // de large. C'est CA que le joueur appelait « les tirs sont sur moi », et
    // c'est donc ca qu'on mesure, plutot que la vitesse brute.
    expect((2 * PROJECTILE_HIT_RADIUS) / relative, laPlusLente.name).toBeLessThanOrEqual(1 / 3);
    // Avant l'etape 8, la grenade (350 px/s) mettait plus du double.
    expect((2 * PROJECTILE_HIT_RADIUS) / (350 - PLAYER_SPEED)).toBeGreaterThan(2 / 3);
  });
});

/**
 * Étape 8 — **les familles d'armes**, demandees par l'auteur : *« il faut
 * varier les types, pas que des projectiles »*.
 */
describe('WeaponKind — ce qu une famille change, et ce qu elle ne change pas', () => {
  it('garde le TIR comme cas courant : la ligne absente est la regle', () => {
    expect(WEAPONS.filter((w) => w.kind === 'tir').length).toBeGreaterThan(WEAPONS.length / 2);
  });

  it('donne a tout halo une portee propre, jamais zero', () => {
    for (const w of WEAPONS) {
      if (w.kind === 'halo') {
        // Un halo sans rayon ne toucherait rien : c'est `blastRadius` qui porte
        // sa portee, et le client en derive le disque qu'il dessine.
        expect(w.blastRadius, w.name).toBeGreaterThan(0);
      }
    }
  });

  /**
   * Etape 12 : l'onde et la frappe ne posent aucun projectile, mais lisent les
   * memes champs (`shared/onde-frappe.ts`). Un zero y serait une arme morte :
   * une onde sans rayon max ne touche rien, une onde sans vitesse ne grandit
   * pas, une frappe sans portee tombe sur le tireur.
   */
  it('donne a toute onde et toute frappe de quoi toucher', () => {
    const ondes = WEAPONS.filter((w) => w.kind === 'onde');
    const frappes = WEAPONS.filter((w) => w.kind === 'frappe');
    expect(ondes.length).toBeGreaterThan(0);
    expect(frappes.length).toBeGreaterThan(0);
    for (const w of [...ondes, ...frappes]) {
      expect(w.blastRadius, w.name).toBeGreaterThan(0);
      expect(isLaunched(w), w.name).toBe(true);
    }
    for (const w of ondes) {
      // L'onde balaie un DISQUE : son rayon max depasse le souffle de contact.
      expect(w.blastRadius, w.name).toBeGreaterThan(HEAVY_BLAST_RADIUS);
    }
  });

  it('fait grandir le rayon d un halo a chaque exemplaire, comme une salve grandit', () => {
    const halos = WEAPONS.filter((w) => w.kind === 'halo');
    expect(halos.length).toBeGreaterThan(0);
    for (const w of halos) {
      expect(effectRadius(w, 1), w.name).toBe(w.blastRadius);
      // ⚠️ Les DEUX bornes : a zero exemplaire aussi (l'arme neutre passerait
      // par le meme chemin), et strictement croissant ensuite.
      expect(effectRadius(w, 0), w.name).toBe(w.blastRadius);
      expect(effectRadius(w, 2), w.name).toBeGreaterThan(effectRadius(w, 1));
      expect(effectRadius(w, 5), w.name).toBeGreaterThan(effectRadius(w, 4));
    }
  });
});

/**
 * Étape 8 — **l'invocation**, cinquieme et derniere famille : *« des adds qui
 * tapent et te protegent »*.
 *
 * Ce bloc garde la seule chose que l'invocation ajoute vraiment : son RYTHME.
 * Le reste — ce qui meurt, ce qui est marque — est celui du halo, et c'est
 * `resolveHalos` qui le garde.
 */
describe('Guard — le rythme d une invocation', () => {
  const GARDE = {
    x: 0,
    y: 0,
    bornTick: 100,
    lifeTicks: 150,
    radius: 90,
    damage: 6,
    element: 0,
    by: 1,
  };

  it('frappe DES sa pose : une invocation qui attend se fait eteindre avant', () => {
    expect(guardPulsesAt(GARDE, 100)).toBe(true);
  });

  it('frappe tous les GUARD_PULSE_TICKS, et pas entre deux', () => {
    expect(guardPulsesAt(GARDE, 100 + GUARD_PULSE_TICKS)).toBe(true);
    expect(guardPulsesAt(GARDE, 100 + 2 * GUARD_PULSE_TICKS)).toBe(true);
    for (let age = 1; age < GUARD_PULSE_TICKS; age++) {
      expect(guardPulsesAt(GARDE, 100 + age), `age ${age}`).toBe(false);
    }
  });

  it('ne frappe plus une fois eteinte, meme sur un tick multiple', () => {
    // ⚠️ Le piege du modulo : sans la borne de vie, une invocation morte
    // continuerait de frapper pour toujours, un coup tous les quinze ticks.
    const apres = 100 + GARDE.lifeTicks;
    expect(apres % GUARD_PULSE_TICKS).toBe(100 % GUARD_PULSE_TICKS);
    expect(guardPulsesAt(GARDE, apres)).toBe(false);
    expect(guardIsAlive(GARDE, apres)).toBe(false);
  });

  it('ne frappe pas AVANT d exister', () => {
    expect(guardPulsesAt(GARDE, 85)).toBe(false);
  });

  it('tient exactement sa duree de vie, bornes comprises', () => {
    expect(guardIsAlive(GARDE, 100)).toBe(true);
    expect(guardIsAlive(GARDE, 100 + GARDE.lifeTicks - 1)).toBe(true);
    expect(guardIsAlive(GARDE, 100 + GARDE.lifeTicks)).toBe(false);
  });

  it('donne a l invocation du catalogue de quoi frapper plusieurs fois', () => {
    const invocations = WEAPONS.filter((w) => w.kind === 'invocation');
    expect(invocations.length).toBeGreaterThan(0);
    for (const w of invocations) {
      // Une invocation qui ne frapperait qu'une fois serait un tir, en plus cher.
      expect(w.projectileLifeTicks / GUARD_PULSE_TICKS, w.name).toBeGreaterThan(2);
      // Et elle ne lance rien : meme regle que la mine.
      expect(isLaunched(w), w.name).toBe(false);
      expect(w.blastRadius, w.name).toBeGreaterThan(0);
    }
  });
});

describe('upgradedWeapon — les bonus propres de chaque arme', () => {
  const rien = (): number => 0;
  const seul =
    (aspect: number) =>
    (u: number): number =>
      u === aspect ? 2 : 0;

  it('rend l entree du catalogue elle-meme quand rien n est ameliore', () => {
    for (const w of WEAPONS) {
      expect(upgradedWeapon(w, rien)).toBe(w);
    }
  });

  it('chaque bonus ne touche que SON champ', () => {
    const arc = WEAPONS.find((w) => w.perks.includes(UPGRADE.PIERCE)) as Weapon;
    const salve = upgradedWeapon(arc, seul(UPGRADE.SALVO));
    expect(salve.projectileCount).toBe(salvoCount(arc, 3));
    expect(salve.pierce).toBe(arc.pierce);
    const perce = upgradedWeapon(arc, seul(UPGRADE.PIERCE));
    expect(perce.pierce).toBe(arc.pierce + 2 * PIERCE_PER_UPGRADE);
    expect(perce.projectileCount).toBe(arc.projectileCount);
    const loin = upgradedWeapon(arc, seul(UPGRADE.RANGE));
    expect(loin.projectileLifeTicks).toBeGreaterThan(arc.projectileLifeTicks);
    expect(loin.blastRadius).toBe(arc.blastRadius);
    const zone = upgradedWeapon(arc, seul(UPGRADE.ZONE));
    expect(zone.blastRadius).toBe(effectRadius(arc, 3));
    const gros = upgradedWeapon(arc, seul(UPGRADE.CALIBRE));
    expect(gros.projectileScale).toBeCloseTo(1 + 2 * CALIBRE_PER_UPGRADE, 5);
    const vif = upgradedWeapon(arc, seul(UPGRADE.VELOCITY));
    expect(vif.projectileSpeed).toBeCloseTo(
      arc.projectileSpeed * (1 + 2 * VELOCITY_PER_UPGRADE),
      3,
    );
    const boum = upgradedWeapon(arc, seul(UPGRADE.DETONATION));
    expect(boum.blastRadius).toBe(arc.blastRadius + 2 * DETONATION_RADIUS);
    const venin = upgradedWeapon(arc, seul(UPGRADE.VENOM));
    expect(venin.venom).toBeCloseTo(2 * VENOM_PER_UPGRADE, 5);
    for (const u of [gros, vif, boum, venin]) {
      expect(u.pierce).toBe(arc.pierce);
      expect(u.projectileCount).toBe(arc.projectileCount);
    }
    // Degats et cadence se combinent aux passifs ailleurs : jamais ici.
    for (const u of [salve, perce, loin, zone]) {
      expect(u.damage).toBe(arc.damage);
      expect(u.cooldownTicks).toBe(arc.cooldownTicks);
    }
  });

  it('chaque arme a au moins un bonus propre, et seulement ceux que sa famille sait faire', () => {
    for (const w of WEAPONS) {
      expect(w.perks.length, w.name).toBeGreaterThan(0);
      expect(new Set(w.perks).size, w.name).toBe(w.perks.length);
      expect(w.perks, w.name).not.toContain(UPGRADE.DAMAGE);
      expect(w.perks, w.name).not.toContain(UPGRADE.FIRE_RATE);
      if (w.kind !== 'tir') {
        // Rien qui ne vive que sur un projectile. ⚠️ **Sauf SALVO pour une
        // frappe** (etape 12) : `projectileCount` y compte les eclairs, et
        // une carte en ajoute un — ce n'est pas une carte vide.
        for (const u of [
          ...(w.kind === 'frappe' ? [] : [UPGRADE.SALVO]),
          UPGRADE.PIERCE,
          UPGRADE.CALIBRE,
          UPGRADE.VELOCITY,
          UPGRADE.DETONATION,
          UPGRADE.VENOM,
          UPGRADE.RICOCHET,
          UPGRADE.HOMING,
        ]) {
          expect(w.perks, w.name).not.toContain(u);
        }
      }
      if (w.perks.includes(UPGRADE.HOMING) || w.perks.includes(UPGRADE.RICOCHET)) {
        // Guider ou faire rebondir une mine ne fait rien.
        expect(w.projectileSpeed, w.name).toBeGreaterThan(0);
      }
      if (w.perks.includes(UPGRADE.VELOCITY)) {
        // Accelerer une mine ne fait rien.
        expect(w.projectileSpeed, w.name).toBeGreaterThan(0);
      }
      if (w.perks.includes(UPGRADE.DETONATION)) {
        // Une detonation sur une arme qui explose deja serait une carte « zone »
        // deguisee ; sur une arme rapide, un balayage O(horde) a chaque tir.
        expect(w.blastRadius, w.name).toBe(0);
        expect(w.cooldownTicks, w.name).toBeGreaterThanOrEqual(20);
      }
      if (w.kind === 'halo') {
        // `projectileLifeTicks` est inerte sur un halo.
        expect(w.perks, w.name).not.toContain(UPGRADE.RANGE);
      }
      if (w.perks.includes(UPGRADE.ZONE)) {
        // Grandir un rayon nul ne fait rien.
        expect(w.blastRadius, w.name).toBeGreaterThan(0);
      }
    }
  });
});
