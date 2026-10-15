import { describe, expect, it } from 'vitest';

import { CARD, drawSpread, OWNED_WEIGHT } from './cards';
import { SPREAD_BONUS, WEAPON_SLOTS } from './constants';
import { Loadout } from './loadout';
import { PASSIVES } from './passives';
import { makeRandom } from './random';
import { BASE_WEAPON_ID, UPGRADE_KINDS, WEAPONS } from './weapons';

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
    for (let seed = 1; seed <= 200; seed++) {
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
          expect(c.upgrade).toBeGreaterThanOrEqual(0);
          expect(c.upgrade).toBeLessThan(UPGRADE_KINDS);
          vus.add(c.upgrade ?? -1);
        }
      }
    }
    expect(vus.size).toBe(UPGRADE_KINDS);
  });
});
