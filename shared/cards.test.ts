import { describe, expect, it } from 'vitest';

import { buildPool, CARD, drawSpread } from './cards';
import { SPREAD_BONUS } from './constants';
import { Loadout } from './loadout';
import { PASSIVES } from './passives';
import { makeRandom } from './random';
import { BASE_WEAPON_ID, WEAPONS } from './weapons';

function equipe(...loadouts: Loadout[]): Map<number, Loadout> {
  // Les identifiants de joueur commencent a 1, comme partout dans le salon.
  return new Map(loadouts.map((l, i) => [i + 1, l]));
}

/** Toutes les cartes que `buildPool` peut produire : armes hors neutre, plus passifs. */
const TAILLE_DU_POOL = WEAPONS.length - 1 + PASSIVES.length;

/**
 * L'union qui debloque tout le catalogue — le reglage des tests qui
 * precedent la tache 3 et qui ne portent pas sur le verrou : avec cette
 * union, `buildPool` se comporte exactement comme avant que le verrou existe.
 */
const TOUT_DEBLOQUE = new Set(WEAPONS.map((w) => w.id));

describe('drawSpread', () => {
  it('tire joueurs + SPREAD_BONUS cartes', () => {
    for (const n of [1, 2, 4]) {
      const l = Array.from({ length: n }, () => new Loadout());
      expect(drawSpread(equipe(...l), makeRandom(0x1234), TOUT_DEBLOQUE).length).toBe(
        n + SPREAD_BONUS,
      );
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
      const spread = drawSpread(equipe(autre, porteur), makeRandom(seed), TOUT_DEBLOQUE);
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
        drawSpread(equipe(seul), makeRandom(seed), TOUT_DEBLOQUE).some(
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
      for (const c of drawSpread(equipe(a, b), makeRandom(seed), TOUT_DEBLOQUE)) {
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
      for (const c of drawSpread(
        equipe(new Loadout(), new Loadout()),
        makeRandom(seed),
        TOUT_DEBLOQUE,
      )) {
        expect([CARD.WEAPON, CARD.PASSIVE]).toContain(c.nature);
      }
    }
  });

  it('rend le meme etalage pour la meme graine', () => {
    const a = new Loadout();
    a.addWeapon(2);
    const b = new Loadout();
    expect(drawSpread(equipe(a, b), makeRandom(77), TOUT_DEBLOQUE)).toEqual(
      drawSpread(equipe(a, b), makeRandom(77), TOUT_DEBLOQUE),
    );
  });

  it("ne depend PAS des inventaires : le pool est le meme pour n'importe quelle equipe", () => {
    // ⚠️ `buildPool` ne prend QUE l'union des deblocages de la salle, jamais
    // les inventaires : ce qui varie d'un joueur a l'autre, c'est son
    // ELIGIBILITE devant une carte (`Loadout.canTake`), jamais le contenu de
    // l'etalage. A union, graine et nombre de joueurs egaux, deux equipes aux
    // inventaires opposes voient exactement le meme etalage.
    const garnis = [new Loadout(), new Loadout()];
    garnis[0]?.addWeapon(2);
    garnis[0]?.addWeapon(2);
    garnis[0]?.addPassive(3);
    garnis[1]?.addWeapon(7);
    garnis[1]?.addPassive(0);
    for (let seed = 1; seed <= 40; seed++) {
      expect(drawSpread(equipe(...garnis), makeRandom(seed), TOUT_DEBLOQUE)).toEqual(
        drawSpread(equipe(new Loadout(), new Loadout()), makeRandom(seed), TOUT_DEBLOQUE),
      );
    }
  });

  it('ne rend jamais deux fois la meme carte dans un etalage', () => {
    // Deux cartes identiques rendraient un conflit impossible a lire : deux
    // joueurs poseraient sur « la meme » carte sans etre en conflit.
    for (let seed = 1; seed <= 40; seed++) {
      const spread = drawSpread(
        equipe(new Loadout(), new Loadout()),
        makeRandom(seed),
        TOUT_DEBLOQUE,
      );
      const cles = spread.map((c) => `${c.nature}:${c.refId}`);
      expect(new Set(cles).size).toBe(cles.length);
    }
  });

  it("n'offre JAMAIS l'arme neutre, qui vit hors des slots", () => {
    // ⚠️ Defaut reel, trouve en ecrivant la tache 7 : `buildPool` parcourait
    // `WEAPONS` en entier, arme neutre comprise. La prendre aurait empile
    // l'arme que `Room#fireWeapons` tire DEJA hors des slots, et elle aurait
    // gagne un projectile a chaque carte.
    //
    // On balaie assez de graines pour que chaque carte du pool sorte au moins
    // une fois : un seul tirage ne prouverait rien.
    const vues = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      const spread = drawSpread(equipe(new Loadout()), makeRandom(seed), TOUT_DEBLOQUE);
      for (const carte of spread) {
        vues.add(`${carte.nature}:${carte.refId}`);
        expect(carte.nature === CARD.WEAPON && carte.refId === BASE_WEAPON_ID).toBe(false);
      }
    }
    // ⚠️ **Le garde du garde.** Sans lui, un `buildPool` qui ne rendrait que
    // trois cartes passerait la boucle ci-dessus sans jamais faire sortir
    // l'arme neutre — ni rien d'autre. On COMPTE ce que le balayage a vu :
    // tout le pool, moins l'arme neutre, exactement.
    expect(vues.size).toBe(TAILLE_DU_POOL);
  });
});

describe('etape 7b tache 3 : le pool tire sur l union des deblocages', () => {
  it('une arme verrouillee absente de l union n entre pas dans le pool', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const pool = buildPool(new Set());
    expect(pool.some((c) => c.nature === CARD.WEAPON && c.refId === verrouillee.id)).toBe(false);
  });

  it('la meme arme entre des qu elle est dans l union', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const pool = buildPool(new Set([verrouillee.id]));
    expect(pool.some((c) => c.nature === CARD.WEAPON && c.refId === verrouillee.id)).toBe(true);
  });

  /**
   * ⚠️ Sans cette assertion, un `buildPool` qui rendrait un pool VIDE
   * satisferait les deux tests precedents.
   */
  it('les armes libres et tous les passifs sont la, union vide ou non', () => {
    const pool = buildPool(new Set());
    const libres = WEAPONS.filter((w) => !w.locked && w.id !== BASE_WEAPON_ID);
    for (const w of libres) {
      expect(
        pool.some((c) => c.nature === CARD.WEAPON && c.refId === w.id),
        w.name,
      ).toBe(true);
    }
    expect(pool.filter((c) => c.nature === CARD.PASSIVE)).toHaveLength(PASSIVES.length);
  });
});
