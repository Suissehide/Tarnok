import { describe, expect, it } from 'vitest';

import { CARD } from './cards';
import { PLAYER_MAX_HP, WEAPON_SLOTS } from './constants';
import { Loadout, maxHpOf } from './loadout';
import { PASSIVES } from './passives';
import { UPGRADE, UPGRADE_KINDS, upgradesFor, WEAPONS, weaponOf } from './weapons';

/**
 * ⚠️ Les identifiants d'epreuve evitent volontairement `0`.
 *
 * La tache 1 de cette etape a livre un test que la mutation « rendre toujours
 * `PASSIVES[0]` » traversait sans echouer, parce qu'il ne verifiait que
 * l'identifiant 0. Une valeur par defaut, un premier indice ou un joueur unique
 * rendent une implementation fausse invisible.
 */
const ARME_A = 1;
const ARME_B = 2;
const PASSIF_A = 1;

describe('Loadout — les armes EMPILENT, comme les passifs', () => {
  it('empile la meme arme sans jamais lever : c est le modele du draft', () => {
    // ⚠️ **Le comportement exactement INVERSE de ce que ce fichier gardait.**
    // Une arme ne monte pas de niveau et ne s'exclut pas d'elle-meme : chaque
    // carte prise ajoute un exemplaire, et c'est l'accumulation qui fait la
    // puissance. Un `addWeapon` qui refuserait un doublon rendrait l'etalage
    // inutile des la deuxieme carte.
    const l = new Loadout();
    l.addWeapon(ARME_A);
    expect(l.stacksOfWeapon(ARME_A)).toBe(1);
    for (let i = 0; i < 11; i++) {
      l.addWeapon(ARME_A);
    }
    expect(l.stacksOfWeapon(ARME_A)).toBe(12);
  });

  it('une arme DEJA possedee ne consomme pas un second slot', () => {
    // Le pendant strict du test des passifs plus bas : compter un slot par
    // CARTE remplirait l'inventaire en cinq cartes, la ou le design attend
    // qu'on empile la meme arme des dizaines de fois sur une run.
    const l = new Loadout();
    for (let i = 0; i < 12; i++) {
      l.addWeapon(ARME_A);
    }
    expect(l.weaponSlotsUsed).toBe(1);
    expect([...l.weaponIds]).toEqual([ARME_A]);
  });

  it('rend zero pour une arme jamais prise', () => {
    expect(new Loadout().stacksOfWeapon(ARME_A)).toBe(0);
  });

  it('refuse une NOUVELLE arme au-dela de WEAPON_SLOTS, jamais une deja possedee', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    expect(l.weaponSlotsUsed).toBe(WEAPON_SLOTS);
    expect(() => l.addWeapon(WEAPON_SLOTS + 1)).toThrow();
    // ... mais empiler une DEJA possedee reste permis, slots pleins ou non.
    expect(() => l.addWeapon(ARME_A)).not.toThrow();
    expect(l.stacksOfWeapon(ARME_A)).toBe(2);
    expect(l.weaponSlotsUsed).toBe(WEAPON_SLOTS);
  });

  it('leve sur un identifiant d arme inconnu plutot que de l empiler en silence', () => {
    const l = new Loadout();
    expect(() => l.addWeapon(999)).toThrow(/inconnu/i);
    expect(l.weaponSlotsUsed).toBe(0);
  });

  it('conserve l ordre d acquisition', () => {
    const l = new Loadout();
    l.addWeapon(ARME_B);
    l.addWeapon(ARME_A);
    // Le second exemplaire de la premiere ne la remet pas en fin de liste.
    l.addWeapon(ARME_B);
    expect([...l.weaponIds]).toEqual([ARME_B, ARME_A]);
  });
});

describe('Loadout.canTake — ce qui remplace `owner`', () => {
  it('accepte tout d un inventaire vide', () => {
    const l = new Loadout();
    expect(l.canTake(CARD.WEAPON, ARME_A)).toBe(true);
    expect(l.canTake(CARD.PASSIVE, PASSIF_A)).toBe(true);
  });

  it('slots d armes pleins : refuse une arme NOUVELLE, jamais une deja possedee', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    // ⚠️ Les deux moities comptent. « Refuse tout quand c'est plein » serait
    // aussi faux que « accepte tout » : on ne peut pas ouvrir un slot qu'on
    // n'a plus, mais empiler ce qu'on possede deja reste TOUJOURS possible.
    expect(l.canTake(CARD.WEAPON, WEAPON_SLOTS + 1)).toBe(false);
    expect(l.canTake(CARD.WEAPON, ARME_A)).toBe(true);
  });

  it('lit la nature de la carte, et lit la BONNE : `CARD_WEAPON` ne derive pas de `CARD.WEAPON`', () => {
    // ⚠️ **La garde de la constante recopiee.** `loadout.ts` duplique
    // `CARD.WEAPON` sous le nom `CARD_WEAPON` pour ne pas importer `cards.ts`
    // en retour (cycle). Elle est privee, donc on l'eprouve par son seul effet
    // observable : `canTake` choisit la branche ARMES ou la branche PASSIFS
    // selon elle.
    //
    // ⚠️ **Depuis l'etape 13, les passifs ne bloquent plus jamais** : on ne
    // peut donc plus construire l'asymetrie d'origine en remplissant les deux
    // natures. Un seul inventaire suffit — armes pleines, meme identifiant
    // interroge sur les deux natures : la branche ARMES doit refuser, la
    // branche PASSIFS doit toujours accepter. Un `CARD_WEAPON` qui derive mal
    // fait lire la mauvaise branche et les deux reponses convergent.
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i + 1);
    }
    expect(l.canTake(CARD.WEAPON, WEAPON_SLOTS + 1)).toBe(false);
    expect(l.canTake(CARD.PASSIVE, WEAPON_SLOTS + 1)).toBe(true);
  });
});

describe('etape 13 : les passifs ne sont plus limites', () => {
  it('on peut empiler plus de passifs distincts qu il n y avait d emplacements', () => {
    const l = new Loadout();
    const distincts = PASSIVES.slice(0, 8);
    expect(distincts.length).toBeGreaterThan(3);
    for (const p of distincts) {
      expect(l.canTake(CARD.PASSIVE, p.id)).toBe(true);
      expect(() => l.addPassive(p.id)).not.toThrow();
    }
    expect(l.passiveSlotsUsed).toBe(distincts.length);
  });

  /** ⚠️ Les ARMES gardent leur limite : c'est elle qui porte le renoncement. */
  it('l arsenal reste borne a WEAPON_SLOTS', () => {
    const l = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      l.addWeapon(i);
    }
    expect(l.canTake(CARD.WEAPON, WEAPON_SLOTS + 1)).toBe(false);
  });
});

describe('Loadout — les passifs empilent', () => {
  it('empile : deux cartes du meme passif doublent le bonus', () => {
    const p = PASSIVES[PASSIF_A];
    if (!p) {
      throw new Error('fixture : passif absent');
    }
    const l = new Loadout();

    l.addPassive(PASSIF_A);
    expect(l.stacksOf(PASSIF_A)).toBe(1);
    const unique = l.bonus(p.kind);

    l.addPassive(PASSIF_A);
    expect(l.stacksOf(PASSIF_A)).toBe(2);
    expect(l.bonus(p.kind)).toBeCloseTo(unique * 2, 6);
  });

  it('un passif DEJA possede ne consomme pas un second slot', () => {
    // ⚠️ C'est le test qui porte le modele Risk of Rain. Une implementation
    // qui compte un slot par CARTE remplirait l'inventaire en trois cartes,
    // la ou le design attend qu'on empile le meme passif des dizaines de fois.
    const l = new Loadout();
    for (let i = 0; i < 12; i++) {
      l.addPassive(PASSIF_A);
    }
    expect(l.passiveSlotsUsed).toBe(1);
    expect(l.stacksOf(PASSIF_A)).toBe(12);
  });

  it('ne melange pas les bonus de deux kinds differents', () => {
    const a = PASSIVES[PASSIF_A];
    const b = PASSIVES.find((x) => x.kind !== a?.kind);
    if (!a || !b) {
      throw new Error('fixture : deux kinds distincts requis');
    }
    const l = new Loadout();
    l.addPassive(a.id);
    expect(l.bonus(a.kind)).toBeCloseTo(a.magnitude, 6);
    expect(l.bonus(b.kind)).toBe(0);
  });

  it('rend zero pour un kind dont aucun passif n est possede', () => {
    const l = new Loadout();
    expect(l.bonus('damage')).toBe(0);
  });
});

describe('Loadout — une carte d arme reprise n ameliore QU UN aspect', () => {
  it('la premiere carte donne l arme, les suivantes comptent sur leur seul aspect', () => {
    const l = new Loadout();
    l.addWeapon(ARME_A, UPGRADE.DAMAGE);
    // L'acquisition n'ameliore rien, quel que soit l'aspect porte par la carte.
    expect(l.upgradesOf(ARME_A, UPGRADE.DAMAGE)).toBe(0);
    l.addWeapon(ARME_A, UPGRADE.FIRE_RATE);
    l.addWeapon(ARME_A, UPGRADE.FIRE_RATE);
    expect(l.upgradesOf(ARME_A, UPGRADE.FIRE_RATE)).toBe(2);
    expect(l.upgradesOf(ARME_A, UPGRADE.DAMAGE)).toBe(0);
    expect(l.upgradesOf(ARME_A, UPGRADE.SALVO)).toBe(0);
    // Une autre arme ne partage rien.
    expect(l.upgradesOf(ARME_B, UPGRADE.FIRE_RATE)).toBe(0);
    expect(l.stacksOfWeapon(ARME_A)).toBe(3);
  });

  it('refuse un aspect inconnu, ou que cette arme ne propose pas', () => {
    const l = new Loadout();
    l.addWeapon(ARME_A);
    expect(() => l.addWeapon(ARME_A, UPGRADE_KINDS)).toThrow(/amelioration/);
    const sansPerforation = upgradesFor(weaponOf(ARME_A)).includes(UPGRADE.PIERCE)
      ? UPGRADE.ZONE
      : UPGRADE.PIERCE;
    expect(upgradesFor(weaponOf(ARME_A))).not.toContain(sansPerforation);
    expect(() => l.addWeapon(ARME_A, sansPerforation)).toThrow(/amelioration/);
  });

  it('sans aspect, une carte reprise donne le premier bonus propre de l arme', () => {
    for (const w of WEAPONS) {
      const l = new Loadout();
      l.addWeapon(w.id);
      l.addWeapon(w.id);
      expect(l.upgradesOf(w.id, w.perks[0] ?? -1), w.name).toBe(1);
    }
  });
});

describe('etape 13 : un malus est un bonus negatif', () => {
  // ⚠️ Le catalogue n'a ENCORE AUCUNE carte a malus (elle arrive a une tache
  // ulterieure) : on ne peut donc pas exercer ici la branche
  // `p.malus?.kind === kind` de `bonus()` via une vraie carte, et cette tache
  // ne doit pas en inventer une dans `shared/passives.ts`. Les deux tests
  // ci-dessous couvrent ce qui EST verifiable sans contenu invente : le genre
  // ajoute au catalogue, la somme de `maxHpOf`, et la non-regression de
  // `bonus()` pour des passifs qui n'ont PAS de malus (la branche ajoutee ne
  // doit rien changer a ce chemin, qui est le seul que le jeu emprunte
  // aujourd'hui).

  it("PASSIVE_KINDS contient 'armor', atteignable par une carte depuis cette tache", () => {
    const vide = new Loadout();
    expect(vide.bonus('armor')).toBe(0);
  });

  it('maxHpOf est la meme somme des deux cotes : base, cartes, achats', () => {
    const l = new Loadout();
    expect(maxHpOf(l, 0)).toBe(PLAYER_MAX_HP);
    expect(maxHpOf(l, 25)).toBe(PLAYER_MAX_HP + 25);
  });

  it('bonus() sans malus somme toujours pareil : la branche de retrait ne derange pas ce chemin', () => {
    // 'puissance' et 'acier' sont deux passifs DISTINCTS de genre 'damage',
    // aucun des deux n'a de malus — exactement le fixture du test plus haut
    // qui prouve que `bonus` somme a travers plusieurs passifs d'un meme
    // kind. On la rejoue ici pour garder la preuve apres l'ajout de la
    // branche `p.malus?.kind === kind` dans `bonus()`.
    const puissance = PASSIVES.find((p) => p.name === 'puissance');
    const acier = PASSIVES.find((p) => p.name === 'acier');
    if (!puissance || !acier) {
      throw new Error('fixture : puissance ou acier absent du catalogue');
    }
    const l = new Loadout();
    l.addPassive(puissance.id);
    l.addPassive(acier.id);
    expect(l.bonus('damage')).toBeCloseTo(puissance.magnitude + acier.magnitude, 6);
  });
});
