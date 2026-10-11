import { priceOf, SHOP_ITEMS, type ShopItem } from '@shared/shop';
import { WEAPONS } from '@shared/weapons';

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
 * Cette carte d'arme doit-elle etre grisee dans l'etalage du draft ?
 *
 * ⚠️ **Calcule depuis les achats du joueur LOCAL, jamais recu du serveur.**
 * C'est ce qui permet au grisage de ne couter aucun octet : le `DRAFT_OPEN` ne
 * transporte aucune eligibilite. Le serveur, lui, refuse le jeton — le grisage
 * est une politesse, le refus est la regle.
 *
 * ⚠️ **Pure, et cablee dans `ui/draft.ts#DraftScreen` (ronde de correction
 * 1/5, tache 8) : une carte d'arme verrouillee non debloquee par CE joueur y
 * est grisee et non cliquable** — `DraftScreen` recoit les achats en
 * parametre de construction, jamais via le protocole.
 */
export function carteGrisee(weaponId: number, purchases: Record<string, number>): boolean {
  const arme = WEAPONS.find((w) => w.id === weaponId);
  if (!arme?.locked) {
    return false;
  }
  return !SHOP_ITEMS.some(
    (i) => i.kind === 'weapon' && i.weaponId === weaponId && (purchases[i.id] ?? 0) > 0,
  );
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
 * Peint l'etalage : une ligne par article du catalogue, prix du palier
 * suivant, et un bouton desactive quand `achetable` est faux.
 *
 * `replaceChildren` plutot qu'un diff : au plus `SHOP_ITEMS.length` lignes, et
 * la boutique ne se repeint qu'a l'ouverture du lobby ou apres un achat.
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

      const row = document.createElement('div');
      row.className = 'shop-item';
      row.dataset.itemId = item.id;
      row.dataset.achetable = peut ? 'true' : 'false';

      const label = document.createElement('span');
      label.className = 'shop-item__label';
      label.textContent = item.label;

      const palier = document.createElement('span');
      palier.className = 'shop-item__palier';
      palier.textContent = `${palierPossede} / ${item.levels}`;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'shop-item__buy';
      button.disabled = !peut;
      button.textContent = auMax ? 'Au maximum' : `${priceOf(item, palierPossede + 1)} or`;
      button.addEventListener('click', () => {
        button.disabled = true;
        onBuy(item.id)
          .finally(() => {
            button.disabled = false;
          })
          .catch(() => {
            // Deja gere par le `finally` ci-dessus (reactivation) ; ce
            // `catch` existe seulement pour qu'une promesse rejetee ne
            // remonte pas comme un rejet NON gere (le contrat de `onBuy`
            // n'exige pas qu'elle rejette jamais — `main.ts` ne le fait
            // pas — mais `renderShop` ne doit pas casser si un futur
            // appelant le fait).
          });
      });

      row.append(label, palier, button);
      return row;
    }),
  );
}
