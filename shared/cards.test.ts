import { describe, expect, it } from 'vitest';

import { CARD, drawSpread } from './cards';
import { SPREAD_BONUS, WEAPON_MAX_LEVEL } from './constants';
import { Loadout } from './loadout';
import { makeRandom } from './random';
import { WEAPONS } from './weapons';

/** Une arme qui evolue, avec le passif qu'elle exige — pose par la tache 1. */
const EVOLVING = WEAPONS.find((w) => w.evolutionPassiveId >= 0);
if (!EVOLVING) {
  throw new Error('fixture : aucune arme evolutive dans le catalogue');
}

function equipe(...loadouts: Loadout[]): Map<number, Loadout> {
  // ⚠️ Les identifiants de joueur commencent a 1 : `owner = 0` signifie
  // « ouvert a tous », donc aucun joueur ne peut porter l'identifiant 0.
  return new Map(loadouts.map((l, i) => [i + 1, l]));
}

describe('drawSpread', () => {
  it('tire joueurs + SPREAD_BONUS cartes', () => {
    for (const n of [1, 2, 4]) {
      const l = Array.from({ length: n }, () => new Loadout());
      expect(drawSpread(equipe(...l), makeRandom(0x1234)).length).toBe(n + SPREAD_BONUS);
    }
  });

  it("n'offre jamais en arme neuve une arme portee par UN AUTRE joueur", () => {
    // ⚠️ Deux inventaires, un seul porteur. Avec un seul joueur, une exclusion
    // purement personnelle passerait ce test — or le §6.2 exige l'exclusivite
    // a l'echelle de l'EQUIPE : l'arme sort du pool pour tout le monde.
    const arme = WEAPONS[1];
    if (!arme) {
      throw new Error('fixture : arme absente');
    }
    // ⚠️ Le porteur est le DERNIER de l'equipe, deliberement. Avec le porteur
    // en premier, une implementation qui ne consulte que le premier inventaire
    // — donc une exclusivite PERSONNELLE et non d'equipe — passerait ce test.
    // Verifie : la mutation « ne regarder que le premier loadout » survivait.
    const autre = new Loadout();
    const porteur = new Loadout();
    porteur.addWeapon(arme.id);

    for (let seed = 1; seed <= 40; seed++) {
      const spread = drawSpread(equipe(autre, porteur), makeRandom(seed));
      const offerte = spread.some((c) => c.nature === CARD.NEW_WEAPON && c.refId === arme.id);
      expect(offerte).toBe(false);
    }
  });

  it('donne a une carte de montee de niveau l owner du porteur, jamais 0', () => {
    const arme = WEAPONS[1];
    if (!arme) {
      throw new Error('fixture : arme absente');
    }
    // Le porteur est le joueur 2, pas le 1 : un `owner` code en dur a 1
    // passerait sinon.
    const autre = new Loadout();
    const porteur = new Loadout();
    porteur.addWeapon(arme.id);

    let vues = 0;
    for (let seed = 1; seed <= 60; seed++) {
      for (const c of drawSpread(equipe(autre, porteur), makeRandom(seed))) {
        if (c.nature === CARD.WEAPON_LEVEL) {
          vues++;
          expect(c.owner).toBe(2);
        }
      }
    }
    expect(vues).toBeGreaterThan(0); // sinon le test ne prouve rien
  });

  it('laisse les cartes de passif ouvertes a tous, meme deja possedees', () => {
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
        if (c.nature === CARD.PASSIVE) {
          expect(c.owner).toBe(0);
          if (c.refId === 1) {
            dejaPossedeRevu = true;
          }
        }
      }
    }
    expect(dejaPossedeRevu).toBe(true);
  });

  it('propose l evolution a qui a l arme au maximum ET le passif requis', () => {
    const pret = new Loadout();
    pret.addWeapon(EVOLVING.id);
    for (let n = 1; n < WEAPON_MAX_LEVEL; n++) {
      pret.levelUpWeapon(EVOLVING.id);
    }
    pret.addPassive(EVOLVING.evolutionPassiveId);

    let trouvee = false;
    for (let seed = 1; seed <= 60 && !trouvee; seed++) {
      trouvee = drawSpread(equipe(pret), makeRandom(seed)).some(
        (c) => c.nature === CARD.EVOLUTION && c.refId === EVOLVING.id && c.owner === 1,
      );
    }
    expect(trouvee).toBe(true);
  });

  it('ne propose PAS l evolution sans le passif requis', () => {
    // Le §7.5 conditionne l'evolution a la possession du passif associe.
    const sansPassif = new Loadout();
    sansPassif.addWeapon(EVOLVING.id);
    for (let n = 1; n < WEAPON_MAX_LEVEL; n++) {
      sansPassif.levelUpWeapon(EVOLVING.id);
    }

    for (let seed = 1; seed <= 60; seed++) {
      const spread = drawSpread(equipe(sansPassif), makeRandom(seed));
      expect(spread.some((c) => c.nature === CARD.EVOLUTION)).toBe(false);
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

  it('ne rend jamais deux fois la meme carte dans un etalage', () => {
    // Deux cartes identiques rendraient un conflit impossible a lire : deux
    // joueurs poseraient sur « la meme » carte sans etre en conflit.
    for (let seed = 1; seed <= 40; seed++) {
      const spread = drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed));
      const cles = spread.map((c) => `${c.nature}:${c.refId}:${c.owner}`);
      expect(new Set(cles).size).toBe(cles.length);
    }
  });
});
