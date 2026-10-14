import { priceOf, SHOP_ITEMS, type ShopItem } from '@shared/shop';

import { bonusIcon, slot } from './icons';

/**
 * La boutique du lobby (etape 7b, tache 8).
 *
 * ⚠️ **Union + grisage : l'etalage montre TOUT.** Un article trop cher ou au
 * palier maximum reste dans la liste, grise (bouton desactive) plutot que
 * retire. Montrer ce qu'on pourra debloquer plus tard fait partie de
 * l'interet — decision de l'utilisateur pour cette tache.
 *
 * ⚠️ **Aucun slot d'arme n'est vendu, et ne le sera jamais.** `SHOP_ITEMS`
 * n'a pas de nature pour ca (`shared/shop.ts`, teste a la tache 1) ; cette
 * boutique ne fait qu'afficher le catalogue tel qu'il est.
 */

/** L'etat d'un compte, tel que la boutique en a besoin pour decider ce qui est grise. */
export interface EtatBoutique {
  /**
   * ⚠️ **`bigint`, jamais `number`.** L'or arrive en TEXTE sur le fil
   * (`{ gold: string }`) parce que `bigint` n'est pas serialisable en JSON et
   * qu'un nombre JSON perdrait la precision au-dela de 2^53 alors que la
   * colonne tient jusqu'a 2^63. Convertir en `number` ici pour comparer un
   * prix referait la meme perte sur le client.
   */
  gold: bigint;
  /** Palier atteint par article possede — absent si rien n'a encore ete achete. */
  purchases: Record<string, number>;
}

/** Ce joueur peut-il acheter le palier suivant de cet article ? */
export function achetable(item: ShopItem, etat: EtatBoutique): boolean {
  const palier = (etat.purchases[item.id] ?? 0) + 1;
  if (palier > item.levels) {
    return false;
  }
  return etat.gold >= BigInt(priceOf(item, palier));
}

/**
 * Le message d'un achat refuse, par code HTTP.
 *
 * ⚠️ **402 et 409 ne disent PAS la meme chose** (etape 7b, tache 5) : un 402
 * (solde insuffisant ou palier maximum) demande de gagner plus d'or ; un 409
 * est un conflit d'achat concurrent — rien n'a ete debite, l'action correcte
 * est de rafraichir et retenter. Confondre les deux dirait « solde
 * insuffisant » a un joueur qui a largement de quoi payer, juste parce qu'il a
 * double-clique.
 */
export function messageAchat(status: number): string {
  if (status === 402) {
    return 'Pas assez d’or, ou déjà au palier maximum.';
  }
  if (status === 409) {
    return 'Achat en conflit — réessayez.';
  }
  return 'Achat impossible.';
}

/**
 * L'effet d'un palier, dans l'unite que `Room` applique : les fractions en
 * pourcentage, les PV, px et PV/s en clair.
 */
export function effetLabel(item: ShopItem): string {
  const v = item.perLevel;
  switch (item.bonusKind) {
    case 'damage':
      return `+${Math.round(v * 100)} % dégâts`;
    case 'armor':
      return `−${Math.round(v * 100)} % dégâts subis`;
    case 'maxHp':
      return `+${v} PV max`;
    case 'regen':
      return `+${v} PV/s`;
    case 'speed':
      return `+${v} px/s`;
    case 'pickupRadius':
      return `+${v} px de ramassage`;
    case 'fireRate':
      return `−${Math.round(v * 100)} % recharge`;
    case 'xp':
      return `+${Math.round(v * 100)} % expérience`;
    case 'gold':
      return `+${Math.round(v * 100)} % d’or extrait`;
  }
}

/**
 * Peint l'etalage (ecran 10 de la maquette) : une carte par article, son
 * effet par palier, le palier atteint, et un bouton de prix desactive quand
 * `achetable` est faux.
 *
 * `replaceChildren` plutot qu'un diff : au plus `SHOP_ITEMS.length` cartes, et
 * la boutique ne se repeint qu'a l'ouverture ou apres un achat.
 *
 * ⚠️ **Un achat est definitif : il se confirme.** Le premier clic arme le
 * bouton (« Confirmer ? », en rouge), le second achete. Un clic ailleurs ou un
 * repeint desarme.
 *
 * ⚠️ **`onBuy` rend une promesse, et c'est la garde anti-double-clic (ronde
 * de correction 2/5, tache 8).** Un double-clic rapide envoyait deux `POST` —
 * l'un gagnant (200), l'autre en conflit (409) — et selon l'ordre d'arrivee
 * le joueur pouvait lire « conflit, retente » pour un achat qui avait
 * pourtant reussi. Le correctif est natif : le bouton se desactive AVANT
 * l'appel, et se reactive dans un `finally` — donc quelle que soit l'issue
 * (succes, 402, 409, ou meme une promesse rejetee). Un `then` de succes seul
 * laisserait un achat refuse avec un bouton mort pour toujours.
 */
export function renderShop(
  root: HTMLElement,
  etat: EtatBoutique,
  onBuy: (itemId: string) => Promise<void>,
): void {
  root.replaceChildren(
    ...SHOP_ITEMS.map((item) => {
      const palierPossede = etat.purchases[item.id] ?? 0;
      const auMax = palierPossede >= item.levels;
      const peut = achetable(item, etat);
      const prix = auMax ? 'Au maximum' : `${priceOf(item, palierPossede + 1)} or`;

      const card = document.createElement('div');
      // Le parchemin de la boutique du pack, pave a l'echelle 1.
      card.className = 'k k-scroll shop-card shop-item';
      card.dataset.itemId = item.id;
      card.dataset.achetable = peut ? 'true' : 'false';

      const frame = slot('', { src: bonusIcon(item.bonusKind), count: null, title: item.label });

      const label = document.createElement('span');
      label.className = 'shop-card__name ol';
      label.textContent = item.label;

      const effet = document.createElement('span');
      effet.className = 'shop-card__effect';
      effet.textContent = `${effetLabel(item)} par palier`;

      const palier = document.createElement('span');
      palier.className = 'shop-card__level';
      palier.textContent = `${palierPossede} / ${item.levels}`;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--tab shop-card__buy ol';
      button.disabled = !peut;
      button.textContent = prix;
      const desarme = (): void => {
        delete button.dataset.confirm;
        button.classList.remove('btn--red');
        button.textContent = prix;
      };
      button.addEventListener('blur', desarme);
      button.addEventListener('click', () => {
        if (button.dataset.confirm !== 'true') {
          button.dataset.confirm = 'true';
          button.classList.add('btn--red');
          button.textContent = 'Confirmer ?';
          return;
        }
        desarme();
        button.disabled = true;
        onBuy(item.id)
          .finally(() => {
            button.disabled = false;
          })
          .catch(() => {
            // L'appelant (`main.ts`, `onBuy`) affiche deja l'echec ; ce
            // `catch` n'existe que pour que la promesse rejetee ne remonte pas
            // en erreur non geree une fois le bouton reactive.
          });
      });

      const titre = document.createElement('div');
      titre.className = 'flex flex-col items-start text-left';
      titre.append(label, effet);
      const haut = document.createElement('div');
      haut.className = 'flex items-center gap-[16px] self-stretch';
      haut.append(frame, titre);
      const bas = document.createElement('div');
      bas.className = 'flex items-center justify-between self-stretch';
      bas.append(palier, button);

      card.append(haut, bas);
      return card;
    }),
  );
}
