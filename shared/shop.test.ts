import { ORB_PICKUP_RADIUS, PASSIVE_SLOTS, WEAPON_SLOTS } from '@shared/constants';
import { describe, expect, it } from 'vitest';

import { BONUS_ZERO, bonusesOf, maxBonus, priceOf, SHOP_ITEMS, shopItemOf } from './shop';

describe('etape 7b tache 1 : le catalogue', () => {
  it('chaque identifiant est unique', () => {
    const ids = SHOP_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('chaque article de bonus designe une cle connue', () => {
    const connues = new Set<string>(Object.keys(BONUS_ZERO));
    for (const i of SHOP_ITEMS) {
      expect(connues.has(i.bonusKind), `article ${i.id}`).toBe(true);
    }
  });

  it('tous les prix et tous les paliers sont strictement positifs', () => {
    for (const i of SHOP_ITEMS) {
      expect(i.price, `article ${i.id}`).toBeGreaterThan(0);
      expect(i.levels, `article ${i.id}`).toBeGreaterThan(0);
    }
  });

  /**
   * Le prix du palier `n` est `price * n` : un palier plus haut coute plus
   * cher, et c'est la seule propriete que ce test garde — les valeurs elles
   * memes sont un REGLAGE DE JEU.
   */
  it('le prix croit strictement avec le palier', () => {
    for (const i of SHOP_ITEMS) {
      for (let n = 2; n <= i.levels; n++) {
        expect(priceOf(i, n)).toBeGreaterThan(priceOf(i, n - 1));
      }
    }
  });

  it('shopItemOf retrouve un article, et rend undefined sur un inconnu', () => {
    const premier = SHOP_ITEMS[0];
    if (!premier) {
      throw new Error('catalogue vide');
    }
    expect(shopItemOf(premier.id)).toBe(premier);
    expect(shopItemOf('article-qui-n-existe-pas')).toBeUndefined();
  });

  /**
   * Review Focus n°5 : le rayon voyage dans un `u8` depuis la tache 7. Ce test
   * **derive** le maximum du catalogue, donc un article trop genereux ajoute
   * plus tard fera rougir ICI au lieu de replier silencieusement sur le fil.
   */
  it('le rayon de ramassage maximal tient dans un octet non signe', () => {
    expect(ORB_PICKUP_RADIUS + maxBonus('pickupRadius')).toBeLessThanOrEqual(255);

    // ⚠️ **Le `toBeLessThanOrEqual` seul ne protege rien, et un simple
    // `toBeGreaterThan(0)` non plus.** Un `maxBonus` qui sous-estime rend
    // l'inegalite ci-dessus PLUS vraie, jamais fausse — mesure (Ronde 1) :
    // `maxBonus` rendant `0` ou `1` au lieu de `80` passe les deux aussi bien
    // qu'une vraie implementation. C'est exactement la classe de defaut que
    // ce depot a deja payee une fois (`back/src/room.test.ts:1275` : un `u8`
    // replie huit cartes de vitalite en 4 points de vie au decodage).
    //
    // On epingle donc `maxBonus('pickupRadius')` a ce que l'article du
    // catalogue dit LUI-MEME — ses propres `levels` et `perLevel`, lus ici,
    // jamais recalcules en rebouclant sur `SHOP_ITEMS` (une seconde somme se
    // tromperait avec la premiere). Un seul article nomme : si `maxBonus`
    // rend toujours `0`, ou `1`, ou oublie de multiplier par `levels`, cette
    // egalite rougit.
    //
    // ⚠️ **Piege assume, pas un oubli : le jour ou un SECOND article de rayon
    // rejoint le catalogue, ce test rougira**, parce que `maxBonus` sommera
    // les deux articles alors que cette assertion n'en nomme qu'un. C'est
    // voulu : ajouter un article de rayon est exactement le changement qui
    // remet la marge du `u8` en danger, et son auteur doit etre force de
    // revenir ici recalculer la marge plutot que de laisser le fil decider.
    // Ne pas generaliser cette assertion pour la faire taire sans relire ce
    // commentaire.
    const aimant = SHOP_ITEMS.find((i) => i.id === 'aimant');
    if (!aimant) {
      throw new Error('article aimant introuvable');
    }
    // ⚠️ **Pas de `?? 0` ici.** Si `perLevel` disparaissait de l'article
    // `aimant`, l'attendu redeviendrait `0 * aimant.levels === 0` et cette
    // egalite s'effondrerait en « zero contre zero » si `maxBonus` etait LUI
    // AUSSI mute a rendre 0 — exactement la mutation que ce test existe pour
    // attraper (ronde de correction 2). On leve explicitement.
    if (aimant.perLevel === undefined) {
      throw new Error('l article aimant n a pas de perLevel');
    }
    expect(maxBonus('pickupRadius')).toBe(aimant.levels * aimant.perLevel);
  });

  /**
   * ⚠️ **La clef de voute du pitch, epinglee ici parce que c'est la boutique
   * qui pourrait la briser.**
   *
   * Le §11 de l'orientation listait les « slots » parmi ce que l'or achete.
   * Six slots d'armes font couvrir les QUINZE reactions a un joueur seul
   * (C(6,2) = 15), donc la premiere phrase du README — et le livrable de
   * l'etape 5c qui l'a rendue mesurable — tomberaient ensemble.
   *
   * La VRAIE garde est structurelle, pas nominale : `ShopItem.kind` est type
   * `'weapon' | 'bonus'`, et `bonusKind` est type `BonusKind = PassiveKind |
   * 'pickupRadius'`. Il n'existe aucun champ permettant d'encoder « vendre un
   * slot ». Pour que ce soit meme possible, il faudrait d'abord elargir le
   * type — et c'est CE CHANGEMENT-LA qui serait le vrai point de friction,
   * pas une regex sur les noms. Ce test reste donc sur les CONSTANTES : que
   * WEAPON_SLOTS ne bouge pas (et qu'elle garde son invariant meme si la
   * boutique s'elargit).
   */
  it('WEAPON_SLOTS et PASSIVE_SLOTS ne bougent pas', () => {
    expect(WEAPON_SLOTS).toBe(4);
    expect(PASSIVE_SLOTS).toBe(3);
  });
});

/**
 * `bonusesOf` est descendue ici depuis `back/src/accounts.ts` a la revue
 * finale de l'etape 7b : le miroir de prediction du client en a besoin, et une
 * seconde copie cote front aurait divergé de celle que `Room` applique. Ses
 * tests la suivent.
 */
describe('les bonus d un compte, derives de ses achats', () => {
  it('bonusesOf somme les paliers, et rend zero sur une cle non achetee', () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const b = bonusesOf(new Map([[v.id, 3]]));
    expect(b.maxHp).toBe((v.perLevel ?? 0) * 3);
    expect(b.regen).toBe(0);
  });

  /**
   * ⚠️ **`bonusesOf` rend un objet NEUF a chaque appel, jamais `BONUS_ZERO`.**
   * `BONUS_ZERO` est gele et partage entre `Room.join` et `GameClient` : s'il
   * etait etendu par mutation plutot que par copie, le premier achat du
   * premier joueur ecrirait dans la valeur par defaut de tous les autres — ou
   * leverait, le `freeze` etant en place.
   */
  it('bonusesOf ne touche jamais BONUS_ZERO', () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const b = bonusesOf(new Map([[v.id, 1]]));
    expect(b).not.toBe(BONUS_ZERO);
    expect(BONUS_ZERO.maxHp).toBe(0);
    expect(bonusesOf(new Map())).toEqual(BONUS_ZERO);
  });

  /**
   * Un compte vide ne doit porter AUCUNE cle manquante : `Room` et le miroir
   * du client lisent les cles par nom (`p.accountBonuses.fireRate`, etc.), et
   * un `undefined` y produirait un `NaN` silencieux dans un calcul de jeu.
   */
  it('BONUS_ZERO porte chaque cle a zero', () => {
    expect(Object.values(BONUS_ZERO)).toHaveLength(9);
    for (const v of Object.values(BONUS_ZERO)) {
      expect(v).toBe(0);
    }
  });
});
