import { DECOY_LIFETIME_TICKS } from './abilities';

/**
 * Un leurre : un point qui compte comme cible, a la place de son lanceur.
 *
 * ⚠️ **Ce n'est PAS un deplacement de monstres**, et la distinction decide du
 * risque de cette etape. Le champ de flux est alimente par des positions
 * RETARDEES (`FIELD_INPUT_DELAY_TICKS`), identiques des deux cotes par
 * construction. Un leurre est une entree de ce meme tableau — annonce une fois
 * avec son tick, derive ensuite. Rien ne bouge qui ne bougeait pas.
 */
export interface Decoy {
  /**
   * ⚠️ **L'IDENTIFIANT du lanceur, jamais son indice.** `seen.x` est rempli par
   * l'ordre d'iteration des joueurs : les indices BOUGENT quand quelqu'un part.
   * Un leurre qui retiendrait un indice suivrait le mauvais joueur, et un cran
   * de decalage reassigne toute la horde — une derive qui ne se rattrape pas,
   * puisqu'elle s'accumule a chaque pas.
   */
  readonly playerId: number;
  readonly x: number;
  readonly y: number;
  readonly bornTick: number;
}

/**
 * Rend les positions d'entree du champ, leurres substitues.
 *
 * `tick` est le tick des POSITIONS (`seen.tick`, le tick retarde), jamais le
 * tick courant : c'est lui que les deux cotes partagent. Un leurre agit pour
 * les positions de `bornTick` a `bornTick + DECOY_LIFETIME_TICKS - 1`, et
 * jamais avant sa naissance — sans cette borne basse, le serveur, qui connait
 * le leurre des sa pose, l'appliquerait a des positions plus anciennes que le
 * client, qui l'apprend plus tard.
 *
 * ⚠️ **La longueur des tableaux ne change JAMAIS.** Un cran de decalage sur
 * `seen.x` reassignerait toute la horde a d'autres cibles, et la derive ne se
 * rattrape pas : elle s'accumule a chaque pas. Un leurre dont le lanceur n'est
 * plus dans la salle est donc ignore, jamais pousse a la fin.
 *
 * ⚠️ **Appelee par TOUS les sites d'entree du champ** — `Room#step` et ceux du
 * miroir client. Plusieurs copies de cette regle divergeraient ; une fonction
 * pure ne peut pas.
 */
export function substituteDecoys(
  ids: readonly number[],
  x: readonly number[],
  y: readonly number[],
  decoys: readonly Decoy[],
  tick: number,
): { x: number[]; y: number[] } {
  const sx = [...x];
  const sy = [...y];
  for (const d of decoys) {
    const age = tick - d.bornTick;
    if (age < 0 || age >= DECOY_LIFETIME_TICKS) {
      continue;
    }
    // L'indice se RESOUT ici, a partir du tableau d'identifiants que les deux
    // cotes possedent dans le meme ordre. Un lanceur absent rend -1 : ignore.
    const i = ids.indexOf(d.playerId);
    if (i < 0 || i >= sx.length) {
      continue;
    }
    sx[i] = d.x;
    sy[i] = d.y;
  }
  return { x: sx, y: sy };
}
