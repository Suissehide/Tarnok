/**
 * Les classes : **un verbe et un trait, jamais un element, jamais une arme.**
 *
 * ⚠️ **Le garde est ce TYPE, pas un test.** `GameClass` n'a aucun champ
 * d'element ni d'arme, donc une classe ne peut pas en porter. L'arme (donc
 * l'element) se choisit a la salle d'attente : la classe a un metier propre,
 * sans recouvrement.
 */
export type VerbKind = 'amorce' | 'rempart' | 'appat' | 'relais';

/**
 * Un trait change une REGLE, jamais un nombre.
 *
 * ⚠️ **Contrainte dure.** La boutique vend deja des bonus CHIFFRES de
 * statistiques de depart. Un trait chiffre ferait d'une
 * classe « un article de boutique gratuit, plus un verbe », et les deux
 * systemes se marcheraient dessus.
 */
export type TraitKind =
  /** Toute reaction declenchee dans vos zones laisse un effet au sol, pas seulement trois sur quinze. */
  | 'residuPartout'
  /** Votre reduction de degats protege aussi l'allie adjacent. */
  | 'remparteAllie'
  /** Votre leurre porte l'element de votre arme. */
  | 'leurreElementaire'
  /** L'allie concerne par votre Relais est brievement intangible. */
  | 'relaisIntangible';

export interface GameClass {
  readonly id: number;
  readonly label: string;
  readonly verb: VerbKind;
  readonly trait: TraitKind;
}

/**
 * ⚠️ **L'ordre fixe les identifiants, et ils voyagent sur le fil** (`PICK`,
 * `LOBBY`). Inserer une classe au milieu changerait le verbe de tout le monde :
 * on ajoute a la FIN, jamais au milieu.
 */
export const CLASSES: readonly GameClass[] = Object.freeze([
  Object.freeze({ id: 0, label: 'Amorce', verb: 'amorce', trait: 'residuPartout' }),
  Object.freeze({ id: 1, label: 'Rempart', verb: 'rempart', trait: 'remparteAllie' }),
  Object.freeze({ id: 2, label: 'Appât', verb: 'appat', trait: 'leurreElementaire' }),
  Object.freeze({ id: 3, label: 'Relais', verb: 'relais', trait: 'relaisIntangible' }),
] as const);

/**
 * La classe d'un joueur qui n'a rien choisi.
 *
 * ⚠️ **L'absence de choix est un etat VALIDE, jamais un blocage du depart** —
 * meme discipline que `NO_WEAPON` au salon. Un joueur qui ne clique pas doit
 * pouvoir jouer.
 */
export const DEFAULT_CLASS_ID = 0;

export function classOf(id: number): GameClass | undefined {
  return CLASSES.find((c) => c.id === id);
}
