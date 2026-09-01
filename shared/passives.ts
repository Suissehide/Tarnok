/**
 * Le catalogue des passifs (§3.3 de la spec de l'etape 4).
 *
 * Meme motif que `archetypes.ts` et `weapons.ts` : une table pilotee par la
 * donnee, l'index dans le tableau **est** l'identifiant, rien a synchroniser
 * entre serveur et clients.
 *
 * Modele Risk of Rain. Un passif ne monte jamais de niveau et ne se remplace
 * jamais : il **s'empile** — chaque carte prise s'ajoute aux precedentes
 * (`Loadout.addPassive`, tache 2). Consequence directe (§3.4) : l'etalage
 * n'exclut **jamais** un passif deja possede, meme par plusieurs cartes —
 * toute carte de passif reste convoitee par les N joueurs en permanence, ce
 * qui fait du conflit le regime normal du draft plutot qu'un accident.
 */

/**
 * La grandeur mesurable qu'un passif fait varier.
 *
 * Restreint a des nombres deja mesurables ailleurs dans le jeu
 * (`Weapon.cooldownTicks`, `Weapon.damage`, `PLAYER_MAX_HP`, `PLAYER_SPEED`)
 * pour que la tache 8 puisse verifier qu'empiler deux cartes double bien le
 * bonus applique — un passif dont l'effet ne touche rien de mesurable ne se
 * pretterait pas a cette verification.
 *
 * ⚠️ **`regen` est le seul genre qui agit A CHAQUE TICK** (etape 6a, tache 17,
 * sur retour de jeu : *« il faut un moyen de regen aussi »*). Les quatre autres
 * modulent une grandeur lue au moment ou elle sert — une recharge, un degat,
 * un plafond, une vitesse ; celui-ci MUTE `PlayerState.hp`. C'est pour ca qu'il
 * vit dans `Room.step` et nulle part ailleurs : `hp` est arbitre par le
 * serveur seul (§5.4), et une regeneration appliquee des deux cotes ferait
 * diverger deux barres de vie.
 */
export type PassiveKind = 'fireRate' | 'damage' | 'maxHp' | 'speed' | 'regen';

export interface Passive {
  id: number;
  name: string;
  /** Bonus apporte par CHAQUE carte prise (voir la doc de `PassiveKind`) — jamais un total cumule. */
  magnitude: number;
  kind: PassiveKind;
}

/**
 * L'index de cette table **est** l'identifiant (voir `PASSIVES` plus bas) :
 * ajouter un passif est du contenu, pas de l'architecture.
 */
const PASSIVE_DEFS: readonly Omit<Passive, 'id'>[] = [
  {
    // Points de vie maximum ajoutes par carte, en points bruts.
    name: 'vitalite',
    kind: 'maxHp',
    magnitude: 20,
  },
  {
    // Fraction de `Weapon.cooldownTicks` retiree par carte, appliquee a
    // chaque arme possedee (0.08 = -8 % de cadence par carte).
    name: 'cadence',
    kind: 'fireRate',
    magnitude: 0.08,
  },
  {
    // Fraction de `Weapon.damage` ajoutee par carte, appliquee a chaque arme
    // possedee (0.10 = +10 % de degats par carte).
    name: 'puissance',
    kind: 'damage',
    magnitude: 0.1,
  },
  {
    // Vitesse de deplacement ajoutee par carte, en pixels monde par seconde
    // (voir `PLAYER_SPEED`).
    name: 'fougue',
    kind: 'speed',
    magnitude: 15,
  },
  {
    // Second passif de degats, magnitude differente de « puissance » : prouve
    // que `Loadout.bonus(kind)` (tache 2) somme a travers plusieurs passifs
    // distincts du meme `kind`, pas seulement les cartes d'un meme passif.
    name: 'acier',
    kind: 'damage',
    magnitude: 0.06,
  },
  {
    // Points de vie rendus par carte et par SECONDE (`Room.step` divise par
    // `TICK_HZ`).
    //
    // ⚠️ **RIEN NE SOIGNAIT avant cette carte.** « vitalite » releve le
    // plafond et donne le delta UNE FOIS ; passe ce cadeau, la vie ne
    // remontait jamais de la partie. Se soigner devient donc un CHOIX DE
    // CONSTRUCTION — le draft existe, l'empilement existe, `bonus(kind)`
    // existe — et pas un cadeau : c'est ce que le modele Risk of Rain de
    // l'etape 4 appelle de ses vœux.
    //
    // ⚠️ **Par seconde, pas par tick, et la difference n'est pas cosmetique.**
    // Une magnitude par tick vaudrait 0,0667 : illisible sur une carte, et
    // impossible a comparer aux 20 points bruts de « vitalite ». Le nombre que
    // le joueur lit doit etre celui qu'il ressent.
    //
    // ⚠️ **2 se juge contre `CONTACT_DAMAGE` (8) tous les
    // `CONTACT_INTERVAL_TICKS` (15, soit 0,5 s), c'est-a-dire 16 PV/s au
    // contact.** Une carte rend donc un huitieme de ce que coute le fait de
    // rester dans la horde : elle recompense le DESENGAGEMENT, elle ne rend
    // jamais un joueur immortel dedans. Empilee huit fois elle annulerait le
    // contact — et il faudrait huit cartes, donc une construction entiere.
    name: 'regain',
    kind: 'regen',
    magnitude: 2,
  },
];

export const PASSIVES: readonly Passive[] = PASSIVE_DEFS.map((p, id) => ({ ...p, id }));

export function passiveOf(id: number): Passive {
  const found = PASSIVES[id];
  if (!found) {
    throw new Error(`passif inconnu : ${id}`);
  }
  return found;
}
