import { SYNERGY_MAX } from '@shared/constants';
import type { Loadout } from '@shared/loadout';
import { PASSIVES } from '@shared/passives';

import type { HudInfo } from '../render/stage';
import { formatGold } from './portal';

/**
 * La jauge de Synergie du HUD — derniere ligne de la hierarchie du §6.6 :
 * *« la barre de Synergie : une jauge dans le HUD, visible de tous »*.
 *
 * En DOM et pas en Pixi, comme tout le reste du HUD (pv, niveau, chronometre,
 * gel) : c'est de l'interface, pas du monde. Le §6.6 la chiffre a « 1 quad »
 * pour dire qu'elle ne coute rien, pas pour exiger qu'elle soit dessinee par
 * le moteur.
 *
 * ⚠️ **Dans un module a part, et pas dans `main.ts`.** `main.ts` fait
 * `await stage.init()` au niveau module : il n'est pas importable en test, et
 * tout ce qu'on y ecrit devient invisible a la suite. La dette de l'etape 4
 * est exactement la (`draftScreen.update()`, que rien ne garde). Ici, la
 * regle — combien la barre est pleine, et ce qu'elle affiche — vit dans une
 * fonction testable sous jsdom ; il ne reste dans `main.ts` que l'appel.
 */

/**
 * Part de la barre effectivement remplie, dans `[0, 1]`.
 *
 * ⚠️ **Borne HAUTE indispensable.** `SYNERGY_MAX` est un plafond que le
 * serveur applique deja (tache 8), mais un client qui recevrait un total plus
 * grand — version de serveur plus recente, plafond releve — dessinerait une
 * barre qui deborde de son cadre. La borne BASSE, elle, ne peut pas etre
 * franchie : le total est un `u16` sur le fil.
 *
 * `SYNERGY_MAX` est lu dans `shared/`, jamais recopie : c'est le meme nombre
 * que celui contre lequel le serveur plafonne, et deux copies feraient une
 * jauge qui ment sur sa propre echelle.
 */
export function synergyRatio(synergy: number): number {
  return Math.min(1, Math.max(0, synergy / SYNERGY_MAX));
}

/**
 * Peint la jauge : la largeur du remplissage, et le compte en clair.
 *
 * Le compte en clair accompagne la barre parce que la barre seule ne dit pas
 * ce qui la fait monter — et ce qui la fait monter (deux joueurs differents a
 * l'origine d'une reaction, §7) est *« le coeur du projet »*. Un joueur qui
 * voit `3 / 20` bouger d'un cran juste apres un flash blanc fait le lien ; une
 * barre qui glisse de trois pixels, non.
 */
export function paintSynergy(fill: HTMLElement, label: HTMLElement, synergy: number): void {
  fill.style.width = `${synergyRatio(synergy) * 100}%`;
  label.textContent = `${synergy} / ${SYNERGY_MAX}`;
}

/**
 * Une ligne de la colonne des passifs : ce qu'on a pris, et **combien de
 * fois**.
 *
 * ⚠️ **`stacks` n'est pas une decoration.** Rien ne monte de niveau dans ce
 * jeu : chaque carte s'empile et ajoute une fois sa `magnitude` (§3.3 de la
 * spec de l'etape 4). « vitalite » pris quatre fois et « vitalite » pris une
 * fois sont deux builds differents, et une colonne qui n'afficherait que les
 * noms les decrirait de la meme facon.
 */
export interface PassiveRow {
  name: string;
  stacks: number;
}

/**
 * Ce que la colonne lit du client : qui je suis, et ce que je possede.
 *
 * Une interface structurelle plutot que `GameClient` — meme motif que
 * `FrameClient` et `DraftSource` : `GameClient` la satisfait sans rien
 * declarer, et le test peut en fabriquer un double sans ouvrir de WebSocket.
 *
 * ⚠️ **Rien a ajouter au protocole.** `GameClient.loadoutOf` tient le miroir
 * des inventaires depuis l'etape 4, reconstitue des `DRAFT_RESULT` recus : les
 * passifs sont deja la, cote client, et les annoncer une seconde fois serait
 * du trafic pour une information deja connue.
 */
export interface HudSource {
  readonly localId: number | null;
  /**
   * L'or NON SECURISE de l'equipe, tel que le dernier snapshot le porte (§5 de
   * l'etape 6a).
   *
   * ⚠️ **Lu sur le client, pas sur `RenderState`.** `RenderState` est ce que la
   * PREDICTION produit ; l'or n'est ni predit ni interpole, c'est une valeur
   * d'en-tete lue telle quelle — exactement le motif qui a tenu `boss` hors de
   * `RenderState` a la tache 5.
   */
  readonly gold: number;
  loadoutOf(playerId: number): Loadout;
}

/**
 * Les passifs du joueur LOCAL, dans l'ordre du catalogue.
 *
 * ⚠️ **L'ordre du catalogue, pas l'ordre d'acquisition** : `Loadout` ne retient
 * l'ordre de draft que pour les armes (`weaponIds`, l'ordre des slots). Un
 * ordre stable vaut mieux qu'un ordre juste — la colonne se relit d'un coup
 * d'oeil pendant une vague, et des lignes qui se reordonnent a chaque carte
 * prise obligeraient a la relire en entier.
 *
 * `localId` nul — avant le premier snapshot qui fait apparaitre le joueur —
 * rend une colonne vide plutot qu'un inventaire d'emprunt : `loadoutOf` cree
 * l'entree manquante a la volee, donc l'appeler avec un identifiant invente
 * garnirait la `Map` du client d'un joueur qui n'existe pas.
 */
export function passiveRows(source: HudSource): PassiveRow[] {
  const id = source.localId;
  if (id === null) {
    return [];
  }
  const loadout = source.loadoutOf(id);
  const rows: PassiveRow[] = [];
  for (const passive of PASSIVES) {
    const stacks = loadout.stacksOf(passive.id);
    if (stacks > 0) {
      rows.push({ name: passive.name, stacks });
    }
  }
  return rows;
}

/**
 * Peint la colonne : une ligne par passif possede, et le cadre efface tant
 * qu'il n'y a rien a y mettre.
 *
 * `replaceChildren` plutot qu'un diff : au plus `PASSIVES.length` lignes, une
 * fois par image, et la colonne ne change qu'a la montee de niveau.
 */
export function paintPassives(
  box: HTMLElement,
  list: HTMLElement,
  rows: readonly PassiveRow[],
): void {
  const empty = rows.length === 0;
  box.classList.toggle('hidden', empty);
  box.classList.toggle('flex', !empty);
  list.replaceChildren(
    ...rows.map((row) => {
      const line = document.createElement('span');
      // ⚠️ Pas de `data-passive` en plus du texte : il a existe, aucune
      // mutation ne pouvait le tuer (rien ne le lit, ni la CSS ni un test).
      // Solde comme les autres survivants de ce depot, par une suppression.
      line.className = 'hud-passive';
      // Le compte se lit meme a un seul exemplaire : « ×1 » puis « ×2 » dit
      // qu'on vient d'empiler, la ou un nom qui ne bouge pas ne dit rien.
      line.textContent = `${row.name} ×${row.stacks}`;
      return line;
    }),
  );
}

/**
 * Les elements du HUD, tels que `index.html` les nomme.
 *
 * Passes en argument plutot que cherches ici : `paintHud` reste alors une
 * fonction qui ecrit dans ce qu'on lui donne, et le test peut lui donner le
 * vrai `index.html` monte sous jsdom — c'est ce qui verifie le CABLAGE, et
 * pas seulement l'ecriture.
 */
export interface HudElements {
  hp: HTMLElement;
  level: HTMLElement;
  timer: HTMLElement;
  lateDeaths: HTMLElement;
  synergyFill: HTMLElement;
  synergyLabel: HTMLElement;
  /** La cagnotte non securisee (§5 de l'etape 6a), visible en permanence. */
  gold: HTMLElement;
  freeze: HTMLElement;
  /** Le cadre de la colonne des passifs — efface tant que rien n'est drafte. */
  passives: HTMLElement;
  /** Les lignes de cette colonne. */
  passiveList: HTMLElement;
}

/**
 * Ecrit tout le HUD (§4.6 : un HUD, pas des logs) a partir du contenu pur
 * calcule par `hudInfo`.
 *
 * ⚠️ **Tache 9 bis : cette fonction vivait dans `main.ts`, donc nulle part.**
 * Retirer l'appel a `paintSynergy` y laissait la suite entierement verte a 170
 * tests — la jauge de Synergie, *« le coeur du projet »* (§7), n'etait gardee
 * par rien d'autre que sa propre fonction, jamais par le fait qu'on l'appelle.
 * Ici, une mutation qui retire une seule de ces lignes rougit.
 *
 * `lateDeaths` et `synergy` ne sont pas dans `HudInfo` : le premier vient de
 * `GameClient.lateDeaths` (compteur de diagnostic, §2), le second de
 * `RenderState.synergy` (donnee d'equipe du snapshot, comme l'xp).
 *
 * ⚠️ **`source` est le client lui-meme, pas une liste deja calculee** (tache
 * 18). Passer les lignes toutes faites remettrait le `passiveRows(client)` de
 * l'appel dans `main.ts`, c'est-a-dire exactement la ou trois etapes de suite
 * ont perdu une ligne de cablage sans qu'une seule assertion ne le voie. Ici,
 * une mutation qui rend `[]` au lieu de la colonne rougit.
 */
export function paintHud(
  el: HudElements,
  info: HudInfo,
  lateDeaths: number,
  synergy: number,
  source: HudSource,
): void {
  el.hp.textContent = `${info.hp}`;
  el.level.textContent = `${info.level}`;
  el.timer.textContent = `Temps ${info.timer}`;
  el.lateDeaths.textContent = `${lateDeaths}`;
  paintSynergy(el.synergyFill, el.synergyLabel, synergy);
  // Tache 10 : la cagnotte NON SECURISEE, en permanence et pas seulement au
  // moment du vote. Le §5 en fait un enjeu qui se vit pendant tout un palier —
  // cinq minutes ou rien n'est acquis — et un chiffre qu'on ne decouvrirait
  // qu'a l'ouverture du portail se lirait comme un score de fin de manche.
  // `formatGold` est celui de l'ecran du portail, importe plutot que recopie :
  // deux ecritures du meme montant se contrediraient tot ou tard.
  el.gold.textContent = formatGold(source.gold);
  paintPassives(el.passives, el.passiveList, passiveRows(source));
  // Tache 24 : seule indication du gel de niveau avant l'etalage de cartes
  // (etape 4) — sans elle, les deux secondes ou tout s'arrete se lisent comme
  // un plantage plutot que comme une pause voulue.
  el.freeze.classList.toggle('hidden', !info.frozen);
}
