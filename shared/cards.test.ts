import { describe, expect, it } from 'vitest';

import {
  applicationsOf,
  applyCardToLoadout,
  CARD,
  type Card,
  drawSpread,
  OWNED_WEIGHT,
  rarityForTier,
  tierOf,
} from './cards';
import { SPREAD_BONUS, WEAPON_SLOTS } from './constants';
import { Loadout } from './loadout';
import { PASSIVES } from './passives';
import { makeRandom } from './random';
import { CHEST_RARITY_FLOOR, RARITY } from './rarity';
import { BASE_WEAPON_ID, UPGRADE_KINDS, upgradesFor, WEAPONS, type Weapon } from './weapons';

function equipe(...loadouts: Loadout[]): Map<number, Loadout> {
  // Les identifiants de joueur commencent a 1, comme partout dans le salon.
  return new Map(loadouts.map((l, i) => [i + 1, l]));
}

/**
 * Toutes les cartes que `buildPool` peut produire, hors cartes de palier, qui
 * n'ont que les 8 % d'emplacements epiques et legendaires.
 */
const TAILLE_DU_POOL = WEAPONS.length + PASSIVES.filter((p) => !p.tier).length;

describe('drawSpread', () => {
  it('tire joueurs + SPREAD_BONUS cartes', () => {
    for (const n of [1, 2, 4]) {
      const l = Array.from({ length: n }, () => new Loadout());
      expect(drawSpread(equipe(...l), makeRandom(0x1234)).length).toBe(n + SPREAD_BONUS);
    }
  });

  it('offre TOUJOURS une arme deja portee par un allie : il n y a aucune exclusivite d equipe', () => {
    // ⚠️ Chacun garde son propre exemplaire : ce qui se dispute, c'est la
    // carte de CET etalage-ci, jamais l'arme de l'autre.
    //
    // ⚠️ Le porteur est le DERNIER de l'equipe, deliberement, et le seul a
    // porter quoi que ce soit : une exclusivite partielle (« ne consulter que
    // le premier inventaire ») resterait sinon invisible.
    const arme = WEAPONS[3]; // lance-flammes
    if (!arme) {
      throw new Error('fixture : arme absente');
    }
    const autre = new Loadout();
    const porteur = new Loadout();
    porteur.addWeapon(arme.id);

    // On EXIGE de la revoir, on ne se contente pas de « elle n'est pas
    // interdite » : sur 60 graines, une carte encore eligible ressort
    // forcement. Si elle etait exclue, ce compteur
    // resterait a zero.
    let revue = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const spread = drawSpread(equipe(autre, porteur), makeRandom(seed));
      if (spread.some((c) => c.nature === CARD.WEAPON && c.refId === arme.id)) {
        revue++;
      }
    }
    expect(revue).toBeGreaterThan(0);
  });

  it('offre aussi une arme que le joueur porte DEJA LUI-MEME : les armes s empilent', () => {
    // Le pendant personnel du precedent. Rien ne s'exclut d'etre deja possede,
    // ni pour soi ni pour l'equipe — c'est ce qui fait du conflit le regime
    // NORMAL du draft plutot qu'un accident.
    const arme = WEAPONS[3];
    if (!arme) {
      throw new Error('fixture : arme absente');
    }
    const seul = new Loadout();
    seul.addWeapon(arme.id);

    let revue = 0;
    for (let seed = 1; seed <= 60; seed++) {
      if (
        drawSpread(equipe(seul), makeRandom(seed)).some(
          (c) => c.nature === CARD.WEAPON && c.refId === arme.id,
        )
      ) {
        revue++;
      }
    }
    expect(revue).toBeGreaterThan(0);
  });

  it('laisse les cartes de passif ouvertes a tous, meme deja empilees', () => {
    const a = new Loadout();
    const b = new Loadout();
    a.addPassive(1);
    a.addPassive(1); // deja empile deux fois : rien a exclure

    // ⚠️ On exige que le passif DEJA EMPILE (id 1) reapparaisse, pas seulement
    // que « des » passifs apparaissent : « exclure les passifs deja possedes »
    // passerait sinon, les autres passifs suffisant.
    let dejaPossedeRevu = false;
    for (let seed = 1; seed <= 60; seed++) {
      for (const c of drawSpread(equipe(a, b), makeRandom(seed))) {
        if (c.nature === CARD.PASSIVE && c.refId === 1) {
          dejaPossedeRevu = true;
        }
      }
    }
    expect(dejaPossedeRevu).toBe(true);
  });

  it('ne connait que deux natures de carte : arme et passif', () => {
    // Une carte d'une troisieme nature traverserait
    // `applyCardToLoadout` sans rien ranger — le draft deviendrait une
    // ceremonie sans effet pour cette carte, en silence.
    for (let seed = 1; seed <= 200; seed++) {
      for (const c of drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed))) {
        expect([CARD.WEAPON, CARD.PASSIVE]).toContain(c.nature);
      }
    }
  });

  it('rend le meme etalage pour la meme graine', () => {
    const a = new Loadout();
    a.addWeapon(2);
    const b = new Loadout();
    expect(drawSpread(equipe(a, b), makeRandom(77))).toEqual(
      drawSpread(equipe(a, b), makeRandom(77)),
    );
  });

  it('fait revenir PLUS SOUVENT ce qu une equipe possede deja : de quoi l ameliorer', () => {
    // Un joueur doit pouvoir reprendre la meme arme pour l'ameliorer :
    // l'etalage depend des inventaires.
    const arme = (spread: { nature: number; refId: number }[]): boolean =>
      spread.some((c) => c.nature === CARD.WEAPON && c.refId === 2);
    let avec = 0;
    let sans = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const garni = new Loadout();
      garni.addWeapon(2);
      if (arme(drawSpread(equipe(garni, new Loadout()), makeRandom(seed)))) {
        avec++;
      }
      if (arme(drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed)))) {
        sans++;
      }
    }
    expect(OWNED_WEIGHT).toBeGreaterThan(1);
    expect(avec).toBeGreaterThan(sans * 2);
  });

  it('ne rend jamais deux fois la meme carte dans un etalage', () => {
    // Deux cartes identiques rendraient un conflit impossible a lire : deux
    // joueurs poseraient sur « la meme » carte sans etre en conflit.
    for (let seed = 1; seed <= 40; seed++) {
      const spread = drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed));
      const cles = spread.map((c) => `${c.nature}:${c.refId}`);
      expect(new Set(cles).size).toBe(cles.length);
    }
  });

  it("offre aussi la dague : une arme comme les autres, qui s'ameliore", () => {
    // La dague vit dans les slots des `Room.join`, et la reprendre l'empile
    // comme n'importe quelle arme.
    //
    // On balaie assez de graines pour que chaque carte du pool sorte au moins
    // une fois : un seul tirage ne prouverait rien.
    const vues = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const spread = drawSpread(equipe(new Loadout()), makeRandom(seed));
      for (const carte of spread) {
        if (tierOf(carte) === undefined) {
          vues.add(`${carte.nature}:${carte.refId}`);
        }
      }
    }
    expect(vues.has(`${CARD.WEAPON}:${BASE_WEAPON_ID}`)).toBe(true);
    // ⚠️ **Le garde du garde.** Sans lui, un `buildPool` qui ne rendrait que
    // trois cartes passerait la boucle ci-dessus sans jamais faire sortir
    // l'arme neutre — ni rien d'autre. On COMPTE ce que le balayage a vu :
    // tout le pool, exactement.
    expect(vues.size).toBe(TAILLE_DU_POOL);
  });
});

describe('drawSpread — rien que personne ne peut prendre', () => {
  /** Un inventaire aux slots d'armes pleins, sans aucune autre arme. */
  function arsenalComplet(): Loadout {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    return l;
  }

  it('ne propose plus une arme nouvelle quand TOUT le monde a son arsenal complet', () => {
    const a = arsenalComplet();
    const b = arsenalComplet();
    for (let seed = 1; seed <= 200; seed++) {
      for (const c of drawSpread(equipe(a, b), makeRandom(seed))) {
        if (c.nature === CARD.WEAPON) {
          expect(c.refId).toBeGreaterThanOrEqual(1);
          expect(c.refId).toBeLessThanOrEqual(WEAPON_SLOTS);
        }
      }
    }
  });

  it('la propose encore tant qu un seul joueur a de la place', () => {
    const a = arsenalComplet();
    let nouvelle = false;
    for (let seed = 1; seed <= 200 && !nouvelle; seed++) {
      nouvelle = drawSpread(equipe(a, new Loadout()), makeRandom(seed)).some(
        (c) => c.nature === CARD.WEAPON && c.refId > WEAPON_SLOTS,
      );
    }
    expect(nouvelle).toBe(true);
  });

  it('chaque carte d arme porte un aspect valide, et tous finissent par sortir', () => {
    const vus = new Set<number>();
    for (let seed = 1; seed <= 100; seed++) {
      for (const c of drawSpread(equipe(new Loadout()), makeRandom(seed))) {
        if (c.nature === CARD.WEAPON) {
          // Seulement un aspect que CETTE arme propose.
          expect(upgradesFor(WEAPONS[c.refId] as Weapon)).toContain(c.upgrade);
          vus.add(c.upgrade ?? -1);
        }
      }
    }
    expect(vus.size).toBe(UPGRADE_KINDS);
  });
});

describe('etape 10 : une carte rare vaut deux cartes, et rien de plus', () => {
  const ARME = WEAPONS[3]; // lance-flammes
  if (!ARME) {
    throw new Error('fixture : arme absente');
  }
  const ASPECT = upgradesFor(ARME)[1] ?? -1; // la cadence, toujours proposee

  // ⚠️ **Pas de x3 au legendaire** : les deux paliers hauts sont des cartes de
  // REGLE, et une regle triplee serait du decor. C'est `RARITY_MULTIPLIERS`
  // qui le dit, pas un cas particulier dans `cards.ts`.
  it('un passif rare donne 2 exemplaires ; commune, epique et legendaire en donnent 1', () => {
    for (const [rarity, attendu] of [
      [undefined, 1],
      [RARITY.COMMUNE, 1],
      [RARITY.RARE, 2],
      [RARITY.EPIQUE, 1],
      [RARITY.LEGENDAIRE, 1],
    ] as const) {
      const l = new Loadout();
      applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: 1, rarity });
      expect(l.stacksOf(1)).toBe(attendu);
      // Un seul emplacement, quelle que soit la rarete.
      expect(l.passiveSlotsUsed).toBe(1);
    }
  });

  it('une arme rare NON possedee : l acquisition, plus un cran de SON aspect', () => {
    const l = new Loadout();
    applyCardToLoadout(l, {
      nature: CARD.WEAPON,
      refId: ARME.id,
      upgrade: ASPECT,
      rarity: RARITY.RARE,
    });
    expect(l.stacksOfWeapon(ARME.id)).toBe(2);
    expect(l.upgradesOf(ARME.id, ASPECT)).toBe(1);
    expect(l.weaponSlotsUsed).toBe(1);
  });

  // ⚠️ Sur une arme DEJA possedee, toutes les applications vont dans
  // l'aspect, aucune ne sert a l'acquisition.
  it('une arme rare DEJA possedee : deux crans de son aspect, rien pour l acquisition', () => {
    const l = new Loadout();
    l.addWeapon(ARME.id);
    applyCardToLoadout(l, {
      nature: CARD.WEAPON,
      refId: ARME.id,
      upgrade: ASPECT,
      rarity: RARITY.RARE,
    });
    expect(l.stacksOfWeapon(ARME.id)).toBe(3);
    expect(l.upgradesOf(ARME.id, ASPECT)).toBe(2);
  });

  it('une rarete hors table venue du fil s applique une fois', () => {
    const l = new Loadout();
    applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: 1, rarity: 200 });
    expect(l.stacksOf(1)).toBe(1);
  });

  it('canTake se juge sur la PREMIERE application : un arsenal plein leve, et rien n est applique', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    const nouvelle: Card = { nature: CARD.WEAPON, refId: WEAPON_SLOTS + 1, rarity: RARITY.RARE };
    expect(() => applyCardToLoadout(l, nouvelle)).toThrow(/pleins/);
    expect(l.stacksOfWeapon(WEAPON_SLOTS + 1)).toBe(0);
    expect(l.weaponSlotsUsed).toBe(WEAPON_SLOTS);
  });

  it('applicationsOf dit combien de fois la carte s applique', () => {
    expect(applicationsOf({ nature: CARD.PASSIVE, refId: 1 })).toBe(1);
    expect(applicationsOf({ nature: CARD.WEAPON, refId: 2, rarity: RARITY.RARE })).toBe(2);
    expect(applicationsOf({ nature: CARD.PASSIVE, refId: 1, rarity: RARITY.EPIQUE })).toBe(1);
    expect(applicationsOf({ nature: CARD.PASSIVE, refId: 1, rarity: RARITY.LEGENDAIRE })).toBe(1);
  });
});

describe('une carte de palier s applique x1 (etape 10, par la table depuis l etape 13)', () => {
  const DE_PALIER = PASSIVES.filter((p) => p.tier !== undefined);

  // ⚠️ C'est la TABLE qui dit x1, pas `applicationsOf` : on l'eprouve donc sur
  // la rarete que la carte peut reellement porter (la sienne), plus une
  // rarete hors table venue du fil, qui se lit commune.
  it('sur son propre palier, et sur une rarete hors table venue du fil', () => {
    expect(DE_PALIER.length).toBe(6);
    for (const p of DE_PALIER) {
      for (const rarity of [rarityForTier(p.tier), 200]) {
        const l = new Loadout();
        const carte: Card = { nature: CARD.PASSIVE, refId: p.id, rarity };
        expect(tierOf(carte)).toBe(p.tier);
        expect(applicationsOf(carte)).toBe(1);
        applyCardToLoadout(l, carte);
        expect(l.stacksOf(p.id)).toBe(1);
      }
    }
  });

  it('il occupe un emplacement de passif comme les autres', () => {
    const l = new Loadout();
    l.addPassive(0);
    l.addPassive(1);
    const dePalier = DE_PALIER[0];
    if (!dePalier) {
      throw new Error('fixture : aucune carte de palier');
    }
    applyCardToLoadout(l, {
      nature: CARD.PASSIVE,
      refId: dePalier.id,
      rarity: rarityForTier(dePalier.tier),
    });
    // ⚠️ Le compte reste, c'est lui que le HUD peint, mais il ne bloque rien :
    // `canTake` resterait `true` ici.
    expect(l.passiveSlotsUsed).toBe(3);
  });

  it('une arme ne porte jamais de palier', () => {
    expect(tierOf({ nature: CARD.WEAPON, refId: 10 })).toBeUndefined();
    expect(rarityForTier(undefined)).toBeUndefined();
  });
});

describe('drawSpread — la rarete (etape 10)', () => {
  it('chaque carte porte une rarete, et les QUATRE finissent par sortir', () => {
    const vues = new Set<number>();
    for (let seed = 1; seed <= 400; seed++) {
      for (const c of drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed))) {
        expect(c.rarity).toBeDefined();
        vues.add(c.rarity ?? -1);
      }
    }
    expect(vues).toEqual(new Set([RARITY.COMMUNE, RARITY.RARE, RARITY.EPIQUE, RARITY.LEGENDAIRE]));
  });

  it('les proportions suivent RARITY_WEIGHTS, a la louche', () => {
    let communes = 0;
    let total = 0;
    for (let seed = 1; seed <= 2000; seed++) {
      for (const c of drawSpread(equipe(new Loadout()), makeRandom(seed))) {
        total++;
        if (c.rarity === RARITY.COMMUNE) {
          communes++;
        }
      }
    }
    expect(communes / total).toBeGreaterThan(0.76);
    expect(communes / total).toBeLessThan(0.88);
  });

  it('une carte de palier ne sort QUE sur un emplacement de SON palier', () => {
    let vus = 0;
    for (let seed = 1; seed <= 3000; seed++) {
      for (const c of drawSpread(equipe(new Loadout()), makeRandom(seed))) {
        const tier = tierOf(c);
        if (tier !== undefined) {
          vus++;
          expect(c.rarity).toBe(rarityForTier(tier));
        }
      }
    }
    // Non-vacuite : sans cette ligne, un tirage qui ne les offrirait JAMAIS
    // passerait l'assertion ci-dessus a vide.
    expect(vus).toBeGreaterThan(0);
  });
});

describe('etape 11 : drawSpread au plancher du coffre', () => {
  it('aucune carte commune sur 500 graines, des legendaires, et chaque palier chez lui', () => {
    let legendaires = 0;
    for (let seed = 1; seed <= 500; seed++) {
      for (const c of drawSpread(
        equipe(new Loadout(), new Loadout()),
        makeRandom(seed),
        CHEST_RARITY_FLOOR,
      )) {
        expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.RARE);
        if (c.rarity === RARITY.LEGENDAIRE) {
          legendaires++;
        }
        const tier = tierOf(c);
        if (tier !== undefined) {
          expect(c.rarity).toBe(rarityForTier(tier));
        }
      }
    }
    // Non-vacuite : un plancher qui ne rendrait QUE du rare passerait le reste.
    expect(legendaires).toBeGreaterThan(0);
  });

  it('sans plancher, l etalage est exactement celui du plancher commun', () => {
    for (let seed = 1; seed <= 50; seed++) {
      const l = new Loadout();
      l.addWeapon(BASE_WEAPON_ID);
      expect(drawSpread(equipe(l, new Loadout()), makeRandom(seed))).toEqual(
        drawSpread(equipe(l, new Loadout()), makeRandom(seed), RARITY.COMMUNE),
      );
    }
  });
});

describe('etape 13 : un palier, un pool', () => {
  /** Fixture : des passifs de chaque palier existent au catalogue. */
  const epiques = PASSIVES.filter((p) => p.tier === 'epique');
  const legendaires = PASSIVES.filter((p) => p.tier === 'legendaire');

  it('le catalogue a de quoi remplir les deux paliers hauts', () => {
    expect(epiques.length).toBeGreaterThan(0);
    expect(legendaires.length).toBeGreaterThan(0);
  });

  it('une carte de palier ne sort que sur son palier, sur 500 graines', () => {
    for (let seed = 1; seed <= 500; seed++) {
      for (const c of drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed))) {
        const tier = tierOf(c);
        if (c.rarity === RARITY.EPIQUE) {
          expect(tier).toBe('epique');
        } else if (c.rarity === RARITY.LEGENDAIRE) {
          expect(tier).toBe('legendaire');
        } else {
          expect(tier).toBeUndefined();
        }
      }
    }
  });

  it('une carte de palier s applique une seule fois, jamais deux', () => {
    const l = new Loadout();
    const epique = PASSIVES.find((p) => p.tier === 'epique');
    if (!epique) {
      throw new Error('fixture : aucun epique au catalogue');
    }
    applyCardToLoadout(l, { nature: CARD.PASSIVE, refId: epique.id, rarity: RARITY.EPIQUE });
    expect(l.stacksOf(epique.id)).toBe(1);
  });

  /**
   * ⚠️ Avec un filtre strict par palier, le `break` de `drawSpread` devient
   * courant, et l'etalage sortirait avec MOINS de cartes que de joueurs.
   *
   * ⚠️ **La cause est l'EPUISEMENT DU POOL, pas des emplacements pleins** (les
   * passifs n'ont pas de limite). `drawSpread` tire sans remise et les
   * epiques se comptent sur une main : au premier emplacement epique de trop,
   * plus rien n'est permis. On force le cas avec un rng qui tire TOUJOURS
   * epique.
   */
  it('pool de palier epuise : l etalage sort quand meme au complet', () => {
    // ⚠️ **Un `rng` CONSTANT, pas un mock.** Avec les poids {72, 20, 6, 2},
    // les bandes CUMULEES sont [0, 72) commune, [72, 92) rare, [92, 98)
    // epique, [98, 100) legendaire : `rollRarity` lit `0,95 x 100 = 95`, donc
    // chaque emplacement tire epique, a chaque fois, et le pool des epiques
    // s'epuise avant la fin de l'etalage.
    const toujoursEpique = (): number => 0.95;
    const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
    const spread = drawSpread(loadouts, toujoursEpique);
    expect(spread).toHaveLength(loadouts.size + SPREAD_BONUS);
    const epiquesAuCatalogue = epiques.length;
    expect(spread.filter((c) => c.rarity === RARITY.EPIQUE)).toHaveLength(epiquesAuCatalogue);
    // Les emplacements au-dela du pool ont REDESCENDU, ils n'ont pas disparu.
    expect(spread.filter((c) => c.rarity !== RARITY.EPIQUE).length).toBe(
      loadouts.size + SPREAD_BONUS - epiquesAuCatalogue,
    );
  });

  /**
   * ⚠️ **La descente enchaine les crans, elle n'en lache pas qu'un.** Un seul
   * `rarity--` sans boucle laisserait un emplacement legendaire retomber sur
   * un palier epique LUI AUSSI vide, et `index < 0` ferait sortir l'etalage
   * incomplet.
   */
  it('deux crans d un coup : legendaire epuise, puis epique epuise, on finit en rare', () => {
    // 0,99 x 100 = 99, dans la bande legendaire cumulee [98, 100).
    const toujoursLegendaire = (): number => 0.99;
    const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
    const spread = drawSpread(loadouts, toujoursLegendaire);
    expect(spread).toHaveLength(loadouts.size + SPREAD_BONUS);
    expect(spread.filter((c) => c.rarity === RARITY.LEGENDAIRE)).toHaveLength(legendaires.length);
    expect(spread.filter((c) => c.rarity === RARITY.EPIQUE)).toHaveLength(epiques.length);
    // Tout le reste a descendu DEUX crans, jusqu'au rare — et rien n'a disparu.
    expect(spread.filter((c) => c.rarity === RARITY.RARE)).toHaveLength(
      loadouts.size + SPREAD_BONUS - legendaires.length - epiques.length,
    );
  });

  it('la descente s arrete au plancher : jamais de commune sous plancher rare', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
      for (const c of drawSpread(loadouts, makeRandom(seed), RARITY.RARE)) {
        expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.RARE);
      }
    }
  });

  /**
   * ⚠️ **Le plancher passe AVANT l'etalage complet.** Sous plancher rare la
   * descente trouve toujours des cartes ordinaires, donc le `> floor` de la
   * boucle ne se distingue pas d'un `> 0` : il fallait un plancher que les
   * seuls paliers ne peuvent pas servir jusqu'au bout pour l'eprouver. A
   * plancher epique l'etalage se raccourcit — c'est le `break` final, et c'est
   * le comportement VOULU : rendre une commune ici trahirait le plancher.
   */
  it('plancher epique : l etalage se raccourcit plutot que de descendre sous le plancher', () => {
    const loadouts = equipe(new Loadout(), new Loadout(), new Loadout(), new Loadout());
    const voulu = loadouts.size + SPREAD_BONUS;
    for (let seed = 1; seed <= 200; seed++) {
      const spread = drawSpread(loadouts, makeRandom(seed), RARITY.EPIQUE);
      for (const c of spread) {
        expect(c.rarity ?? RARITY.COMMUNE).toBeGreaterThanOrEqual(RARITY.EPIQUE);
      }
      // ⚠️ **La longueur exacte depend de la graine, et ce n'est pas une
      // regle.** Selon que le legendaire sort avant ou apres l'epuisement des
      // epiques, l'etalage fait deux ou trois cartes. Ce qui est VRAI a chaque
      // fois, c'est qu'il est plus
      // court que voulu — donc que le `break` a tranche en faveur du plancher
      // — et qu'il ne depasse jamais ce que les deux paliers contiennent.
      expect(spread.length).toBeGreaterThan(0);
      expect(spread.length).toBeLessThan(voulu);
      expect(spread.length).toBeLessThanOrEqual(epiques.length + legendaires.length);
    }
  });
});
