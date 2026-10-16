import { ORB_PICKUP_RADIUS, WEAPON_SLOTS } from '@shared/constants';
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
   * Le rayon voyage dans un `u8`. Ce test **derive** le maximum du catalogue :
   * un article trop genereux fait rougir ICI au lieu de replier silencieusement
   * sur le fil.
   */
  it('le rayon de ramassage maximal tient dans un octet non signe', () => {
    expect(ORB_PICKUP_RADIUS + maxBonus('pickupRadius')).toBeLessThanOrEqual(255);

    // ⚠️ **Le `toBeLessThanOrEqual` seul ne protege rien** : un `maxBonus` qui
    // sous-estime (rend `0` ou `1`) rend l'inegalite PLUS vraie, jamais
    // fausse. On epingle donc `maxBonus('pickupRadius')` a ce que l'article
    // dit LUI-MEME (`levels` et `perLevel`), sans resommer `SHOP_ITEMS` (une
    // seconde somme se tromperait avec la premiere).
    //
    // ⚠️ **Piege voulu : un SECOND article de rayon fera rougir ce test**,
    // puisque `maxBonus` sommera les deux. Ajouter un tel article remet la
    // marge du `u8` en danger : son auteur doit revenir ici la recalculer. Ne
    // pas generaliser cette assertion pour la faire taire.
    const aimant = SHOP_ITEMS.find((i) => i.id === 'aimant');
    if (!aimant) {
      throw new Error('article aimant introuvable');
    }
    // ⚠️ **Pas de `?? 0` ici** : sans `perLevel`, l'attendu vaudrait 0 et un
    // `maxBonus` qui rend 0 passerait (« zero contre zero »). On leve.
    if (aimant.perLevel === undefined) {
      throw new Error('l article aimant n a pas de perLevel');
    }
    expect(maxBonus('pickupRadius')).toBe(aimant.levels * aimant.perLevel);
  });

  /**
   * ⚠️ **La clef de voute du pitch, epinglee ici parce que c'est la boutique
   * qui pourrait la briser.** Six slots d'armes feraient couvrir les QUINZE
   * reactions a un joueur seul (C(6,2) = 15), et la premiere phrase du README
   * tomberait.
   *
   * La vraie garde est structurelle : `ShopItem.kind` vaut `'weapon' |
   * 'bonus'` et `bonusKind` est un `BonusKind`, aucun champ ne sait encoder
   * « vendre un slot ». Ce test garde donc la constante.
   */
  it('WEAPON_SLOTS ne bouge pas', () => {
    // ⚠️ Les passifs n'ont pas de borne : seul l'arsenal garde ce verrou.
    expect(WEAPON_SLOTS).toBe(4);
  });
});

/**
 * `bonusesOf` vit dans `shared/` parce que le miroir de prediction du client
 * doit appliquer exactement la meme somme que `Room`.
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
