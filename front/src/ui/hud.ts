import { SYNERGY_MAX } from '@shared/constants';

import type { HudInfo } from '../render/stage';

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
  freeze: HTMLElement;
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
 */
export function paintHud(
  el: HudElements,
  info: HudInfo,
  lateDeaths: number,
  synergy: number,
): void {
  el.hp.textContent = `${info.hp}`;
  el.level.textContent = `${info.level}`;
  el.timer.textContent = `Temps ${info.timer}`;
  el.lateDeaths.textContent = `${lateDeaths}`;
  paintSynergy(el.synergyFill, el.synergyLabel, synergy);
  // Tache 24 : seule indication du gel de niveau avant l'etalage de cartes
  // (etape 4) — sans elle, les deux secondes ou tout s'arrete se lisent comme
  // un plantage plutot que comme une pause voulue.
  el.freeze.classList.toggle('hidden', !info.frozen);
}
