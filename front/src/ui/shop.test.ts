// @vitest-environment jsdom
import { priceOf, SHOP_ITEMS } from '@shared/shop';
import { BASE_WEAPON_ID, WEAPONS } from '@shared/weapons';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le vrai `index.html` entre dans le bundle de test tel
// quel — meme motif que `hud.test.ts` et `draft.test.ts`, c'est ce qui
// verifie le CABLAGE (l'`id` que `renderShop` ecrit existe reellement dans le
// HTML) et pas seulement la logique d'affichage.
import indexHtml from '../../index.html?raw';
import { achetable, carteGrisee, type EtatBoutique, messageAchat, renderShop } from './shop';

/** Les tests qui n'observent pas les clics n'ont rien a faire dans onBuy. */
const IGNORER_ACHAT = async (): Promise<void> => undefined;

describe('etape 7b tache 8 : la boutique', () => {
  it('un article deja au palier maximum n est plus achetable', () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
    }
    expect(achetable(article, { gold: 10_000n, purchases: { [article.id]: 1 } })).toBe(false);
  });

  it('un article trop cher n est pas achetable, mais reste visible', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    expect(achetable(article, { gold: 0n, purchases: {} })).toBe(false);
  });

  it('un article abordable et non possede est achetable', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    expect(achetable(article, { gold: BigInt(priceOf(article, 1)), purchases: {} })).toBe(true);
  });

  /**
   * ⚠️ **Le grisage du draft ne coute AUCUN octet** : le client connait son
   * propre ensemble, lu en HTTP au chargement. Ce test garde ce predicat.
   */
  it('une arme verrouillee non achetee est grisee, achetee elle ne l est plus', () => {
    const arme = SHOP_ITEMS.find((i) => i.kind === 'weapon');
    if (!arme?.weaponId) {
      throw new Error('aucun article d arme');
    }
    expect(carteGrisee(arme.weaponId, {})).toBe(true);
    expect(carteGrisee(arme.weaponId, { [arme.id]: 1 })).toBe(false);
  });

  it('une arme libre n est jamais grisee', () => {
    const libre = WEAPONS.find((w) => !w.locked && w.id !== BASE_WEAPON_ID);
    if (!libre) {
      throw new Error('aucune arme libre');
    }
    expect(carteGrisee(libre.id, {})).toBe(false);
  });
});

/**
 * Amendement, point 3 : 402 (solde insuffisant / palier max — gagner plus
 * d'or) et 409 (conflit — rafraichir et retenter) ne disent PAS la meme
 * chose. On n'epingle pas la prose exacte, seulement qu'elle differe, et les
 * codes HTTP sont des nombres nus (doctrine du depot pour les contrats de
 * fil) : importer une constante qu'on verifie ne verifierait rien.
 */
describe('messageAchat — les deux codes de refus ne disent pas la meme chose', () => {
  /**
   * ⚠️ **Juste « les deux messages different » est une assertion creuse** :
   * elle survit a l'echange des deux branches (402 <-> 409), puisqu'elles
   * restent differentes l'une de l'autre apres l'echange aussi — verifie en
   * appliquant la mutation. Ce test pointe donc chaque CONTENU vers son
   * CODE : 402 doit parler d'argent/palier (gagner plus d'or), 409 de
   * conflit/retentative — sans epingler la prose exacte au-dela de ce qui
   * distingue les deux cas.
   */
  it('402 parle d or ou de palier (gagner plus, pas retenter)', () => {
    expect(messageAchat(402)).toMatch(/or|palier/i);
    expect(messageAchat(402)).not.toMatch(/conflit|réessay/i);
  });

  it('409 parle de conflit ou de nouvelle tentative (retenter, pas gagner plus)', () => {
    expect(messageAchat(409)).toMatch(/conflit|réessay/i);
    expect(messageAchat(409)).not.toMatch(/or|palier/i);
  });
});

/**
 * `renderShop` monte sur le vrai `index.html` : la ligne qui porte l'etalage
 * (`#shop`) doit exister dans le HTML, pas seulement dans l'imagination du
 * test. Meme discipline que `hud.test.ts` (`front/src/ui/hud.ts:163`).
 */
describe('renderShop — le cablage vers index.html, et le grisage a l ecran', () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = indexHtml;
    const node = document.getElementById('shop');
    if (!node) {
      throw new Error('#shop absent de index.html');
    }
    root = node;
  });

  it('trouve l element que main.ts va chercher', () => {
    // Si `#shop` disparaissait du HTML ou changeait de nom, `el('shop')`
    // leverait au demarrage sans qu'aucune suite ne le voie — sauf celle-ci.
    expect(document.getElementById('shop')).not.toBeNull();
  });

  it('affiche une ligne par article du catalogue, y compris ceux hors de portee', () => {
    renderShop(root, { gold: 0n, purchases: {} }, IGNORER_ACHAT);

    expect(root.querySelectorAll('.shop-item')).toHaveLength(SHOP_ITEMS.length);
  });

  it('un article abordable a un bouton ACTIF', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    renderShop(root, { gold: BigInt(priceOf(article, 1)), purchases: {} }, IGNORER_ACHAT);

    const bouton = root.querySelector<HTMLButtonElement>(`[data-item-id="${article.id}"] button`);
    expect(bouton?.disabled).toBe(false);
  });

  it('un article trop cher reste VISIBLE, mais son bouton est desactive', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    renderShop(root, { gold: 0n, purchases: {} }, IGNORER_ACHAT);

    const ligne = root.querySelector(`[data-item-id="${article.id}"]`);
    const bouton = root.querySelector<HTMLButtonElement>(`[data-item-id="${article.id}"] button`);
    expect(ligne).not.toBeNull();
    expect(bouton?.disabled).toBe(true);
  });

  it('un article deja au palier maximum reste VISIBLE, mais son bouton est desactive', () => {
    const article = SHOP_ITEMS.find((i) => i.levels === 1);
    if (!article) {
      throw new Error('aucun article a un seul palier');
    }
    renderShop(root, { gold: 10_000n, purchases: { [article.id]: 1 } }, IGNORER_ACHAT);

    const ligne = root.querySelector(`[data-item-id="${article.id}"]`);
    const bouton = root.querySelector<HTMLButtonElement>(`[data-item-id="${article.id}"] button`);
    expect(ligne).not.toBeNull();
    expect(bouton?.disabled).toBe(true);
  });

  it('cliquer le bouton d un article abordable declenche onBuy avec son identifiant', () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const appeles: string[] = [];
    const etat: EtatBoutique = { gold: BigInt(priceOf(article, 1)), purchases: {} };
    renderShop(root, etat, async (itemId) => {
      appeles.push(itemId);
    });

    const bouton = root.querySelector<HTMLButtonElement>(`[data-item-id="${article.id}"] button`);
    bouton?.click();

    expect(appeles).toEqual([article.id]);
  });

  /**
   * Ronde de correction 2/5 : la garde anti-double-clic. Un double-clic
   * rapide envoyait deux `POST` — l'un gagne et rend 200, l'autre rend 409 —
   * et selon l'ordre d'arrivee le joueur pouvait voir « conflit, retente »
   * alors que son achat avait reussi. Le correctif est natif : `disabled`
   * pendant que la requete est EN VOL, reactive dans un `finally` (donc quel
   * que soit l'issue — succes, 402, 409, ou meme une promesse rejetee).
   */
  it('un double clic avant resolution n envoie qu un seul achat', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const appeles: string[] = [];
    let debloquer: () => void = () => {
      throw new Error('onBuy jamais appele');
    };
    const onBuy = (itemId: string): Promise<void> => {
      appeles.push(itemId);
      return new Promise<void>((resolve) => {
        debloquer = resolve;
      });
    };
    renderShop(root, { gold: BigInt(priceOf(article, 1)), purchases: {} }, onBuy);

    const bouton = root.querySelector<HTMLButtonElement>(`[data-item-id="${article.id}"] button`);
    bouton?.click();
    // Avant que la premiere requete ne se resolve : le bouton doit deja etre
    // desactive NATIVEMENT, donc ce second clic ne doit pas atteindre onBuy.
    bouton?.click();

    expect(appeles).toEqual([article.id]);

    debloquer();
    await Promise.resolve();
    expect(bouton?.disabled).toBe(false);
  });

  /**
   * ⚠️ **Le `finally` compte, pas un `then` de succes seul** : un achat
   * refuse (ou une promesse rejetee) doit tout de meme reactiver le bouton,
   * sinon un joueur qui gagne de l'or entre-temps ne pourrait plus jamais
   * reessayer cet article.
   */
  it('un achat refuse (promesse rejetee) reactive tout de meme le bouton', async () => {
    const article = SHOP_ITEMS[0];
    if (!article) {
      throw new Error('catalogue vide');
    }
    const onBuy = (): Promise<void> => Promise.reject(new Error('refus simule'));
    renderShop(root, { gold: BigInt(priceOf(article, 1)), purchases: {} }, onBuy);

    const bouton = root.querySelector<HTMLButtonElement>(`[data-item-id="${article.id}"] button`);
    bouton?.click();
    expect(bouton?.disabled).toBe(true);

    // Laisse les microtaches de la promesse rejetee (et son `.finally`) se jouer.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bouton?.disabled).toBe(false);
  });
});
