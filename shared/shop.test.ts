import { ORB_PICKUP_RADIUS, PASSIVE_SLOTS, WEAPON_SLOTS } from '@shared/constants';
import { PASSIVE_KINDS } from '@shared/passives';
import { WEAPONS } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { maxBonus, priceOf, SHOP_ITEMS, shopItemOf } from './shop';

describe('etape 7b tache 1 : le catalogue', () => {
  it('chaque identifiant est unique', () => {
    const ids = SHOP_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /**
   * ⚠️ **Une reference morte ne se verrait qu'au premier achat**, plusieurs
   * taches plus tard. Meme discipline qu'`assertWeaponElements`, qui verifie
   * les references d'elements au CHARGEMENT du module.
   */
  it('chaque article d arme designe une arme qui existe, et elle est verrouillee', () => {
    const armes = SHOP_ITEMS.filter((i) => i.kind === 'weapon');
    expect(armes.length).toBeGreaterThan(0);
    for (const i of armes) {
      const w = WEAPONS.find((w) => w.id === i.weaponId);
      expect(w, `article ${i.id} : arme ${i.weaponId} introuvable`).toBeDefined();
      expect(w?.locked, `article ${i.id} : l arme n est pas verrouillee`).toBe(true);
    }
  });

  it('chaque article de bonus designe une cle connue', () => {
    const connues = new Set<string>([...PASSIVE_KINDS, 'pickupRadius']);
    for (const i of SHOP_ITEMS.filter((i) => i.kind === 'bonus')) {
      expect(connues.has(i.bonusKind ?? ''), `article ${i.id}`).toBe(true);
    }
  });

  it('un deblocage d arme n a qu un seul palier', () => {
    for (const i of SHOP_ITEMS.filter((i) => i.kind === 'weapon')) {
      expect(i.levels, `article ${i.id}`).toBe(1);
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
  });

  it('maxBonus rend zero pour une cle que le catalogue ne vend pas', () => {
    // Verifie que 'regen' n'est pas vendu : aucun article n'a bonusKind === 'regen'
    const vendu = SHOP_ITEMS.some((i) => i.bonusKind === 'regen');
    expect(vendu).toBe(false);
    // Donc maxBonus('regen') doit rendre exactement 0, pas >= 0
    expect(maxBonus('regen')).toBe(0);
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
