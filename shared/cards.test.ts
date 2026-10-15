import { describe, expect, it } from 'vitest';

import {
  applicationsOf,
  applyCardToLoadout,
  CARD,
  type Card,
  drawSpread,
  isLegendaryOnly,
  OWNED_WEIGHT,
} from './cards';
import { SPREAD_BONUS, WEAPON_SLOTS } from './constants';
import { Loadout } from './loadout';
import { PASSIVES } from './passives';
import { makeRandom } from './random';
import { RARITY } from './rarity';
import { BASE_WEAPON_ID, UPGRADE_KINDS, upgradesFor, WEAPONS, type Weapon } from './weapons';

function equipe(...loadouts: Loadout[]): Map<number, Loadout> {
  // Les identifiants de joueur commencent a 1, comme partout dans le salon.
  return new Map(loadouts.map((l, i) => [i + 1, l]));
}

/** Toutes les cartes que `buildPool` peut produire : toutes les armes (dague comprise), plus passifs. */
const TAILLE_DU_POOL = WEAPONS.length + PASSIVES.length;

describe('drawSpread', () => {
  it('tire joueurs + SPREAD_BONUS cartes', () => {
    for (const n of [1, 2, 4]) {
      const l = Array.from({ length: n }, () => new Loadout());
      expect(drawSpread(equipe(...l), makeRandom(0x1234)).length).toBe(n + SPREAD_BONUS);
    }
  });

  it('offre TOUJOURS une arme deja portee par un allie : il n y a aucune exclusivite d equipe', () => {
    // ⚠️ **C'est le point que l'auteur a signale en jouant** : *« si quelqu'un
    // a deja pris lance-flammes, je peux lui voler la carte la prochaine
    // fois »*. Chacun garde son propre exemplaire — ce qui se dispute, c'est
    // la carte de CET etalage-ci, jamais l'arme de l'autre.
    //
    // ⚠️ Le porteur est le DERNIER de l'equipe, deliberement, et le seul a
    // porter quoi que ce soit : c'est la fixture qui rendait l'ancienne
    // exclusivite visible, et elle reste celle qui rendrait visible son
    // retour partiel (« ne consulter que le premier inventaire »).
    const arme = WEAPONS[3]; // lance-flammes
    if (!arme) {
      throw new Error('fixture : arme absente');
    }
    const autre = new Loadout();
    const porteur = new Loadout();
    porteur.addWeapon(arme.id);

    // On EXIGE de la revoir, on ne se contente pas de « elle n'est pas
    // interdite » : avec 60 graines et un pool de treize cartes, une carte
    // encore eligible ressort forcement. Si elle etait exclue, ce compteur
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
    // que « des » passifs apparaissent. Verifie : la mutation « exclure les
    // passifs deja possedes » survivait, parce que les quatre autres passifs
    // suffisaient a satisfaire un test moins precis.
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
    // Les montees de niveau et les evolutions ont existe un temps puis ont ete
    // retirees (§9). Une carte d'une troisieme nature traverserait
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
    // Retour de playtest : *« je dois pouvoir reprendre la meme arme pour
    // l'ameliorer »*. Avant, l'etalage ne dependait pas des inventaires et une
    // arme possedee revenait une fois sur cinq etalages a peine.
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
    // Retour de playtest : la dague vit dans les slots depuis `Room.join`, et
    // la reprendre l'empile comme n'importe quelle arme.
    //
    // On balaie assez de graines pour que chaque carte du pool sorte au moins
    // une fois : un seul tirage ne prouverait rien.
    const vues = new Set<string>();
    for (let seed = 1; seed <= 400; seed++) {
      const spread = drawSpread(equipe(new Loadout()), makeRandom(seed));
      for (const carte of spread) {
        vues.add(`${carte.nature}:${carte.refId}`);
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

  it('un passif rare donne 2 exemplaires, un legendaire 3, une commune 1', () => {
    for (const [rarity, attendu] of [
      [undefined, 1],
      [RARITY.COMMUNE, 1],
      [RARITY.RARE, 2],
      [RARITY.LEGENDAIRE, 3],
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

  it('une arme legendaire DEJA possedee : trois crans de son aspect', () => {
    const l = new Loadout();
    l.addWeapon(ARME.id);
    applyCardToLoadout(l, {
      nature: CARD.WEAPON,
      refId: ARME.id,
      upgrade: ASPECT,
      rarity: RARITY.LEGENDAIRE,
    });
    expect(l.stacksOfWeapon(ARME.id)).toBe(4);
    expect(l.upgradesOf(ARME.id, ASPECT)).toBe(3);
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
    expect(applicationsOf({ nature: CARD.PASSIVE, refId: 1, rarity: RARITY.LEGENDAIRE })).toBe(3);
  });
});

describe('etape 10 : un passif exclusivement legendaire s applique x1', () => {
  const LEGENDAIRES = PASSIVES.filter((p) => p.legendary);

  it('quelle que soit la rarete que la carte porte, fil compris', () => {
    expect(LEGENDAIRES.length).toBe(3);
    for (const p of LEGENDAIRES) {
      for (const rarity of [RARITY.COMMUNE, RARITY.RARE, RARITY.LEGENDAIRE, 200]) {
        const l = new Loadout();
        const carte: Card = { nature: CARD.PASSIVE, refId: p.id, rarity };
        expect(isLegendaryOnly(carte)).toBe(true);
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
    const legendaire = LEGENDAIRES[0];
    if (!legendaire) {
      throw new Error('fixture : aucun legendaire');
    }
    applyCardToLoadout(l, {
      nature: CARD.PASSIVE,
      refId: legendaire.id,
      rarity: RARITY.LEGENDAIRE,
    });
    expect(l.passiveSlotsUsed).toBe(3);
    expect(l.canTake(CARD.PASSIVE, 2)).toBe(false);
  });

  it('une arme n est jamais exclusivement legendaire', () => {
    expect(isLegendaryOnly({ nature: CARD.WEAPON, refId: 10 })).toBe(false);
  });
});
