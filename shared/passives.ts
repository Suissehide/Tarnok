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
export const PASSIVE_KINDS = [
  'fireRate',
  'damage',
  'maxHp',
  'speed',
  'regen',
  'critChance',
  'critDamage',
  'salvo',
  'zone',
  'echo',
  'colossus',
  // Etape 13 : le genre existait deja cote boutique (`BonusKind`) et cote
  // combat (`p.armor`) ; il n'etait simplement pas atteignable par une carte.
  // Une carte ne s'en sert aujourd'hui que pour un MALUS.
  'armor',
] as const;
export type PassiveKind = (typeof PASSIVE_KINDS)[number];

/**
 * Les deux paliers reserves a des cartes de REGLE (etape 13, §2.2). Chacun a
 * son PROPRE pool au tirage : une carte d'un palier ne sort que la.
 */
export type PassiveTier = 'epique' | 'legendaire';

/**
 * Une REGLE portee par une carte — ce qu'un malus chiffre ne peut pas dire.
 *
 * ⚠️ **« PV max -> 1 » n'est PAS `malus: { maxHp, 99 }`** : il doit resister a
 * Vitalite et aux achats du compte, qui s'ajoutent apres. Meme idiome que
 * `Weapon.kind` : un discriminant nomme dont la branche vit a un seul
 * endroit par cote (`maxHpOf`/`maxShieldOf`, `shared/loadout.ts`).
 *
 * ⚠️ **`contagion` (etape 13) suit le meme idiome pour une raison differente** :
 * ce n'est pas qu'un bonus chiffre ne peut pas la dire, c'est qu'elle n'a
 * RIEN a sommer — son effet est une branche a la resolution des morts
 * (`spreadMarkOnDeath`, `back/src/combat.ts`), lue via `Loadout.hasRule`,
 * jamais via `Loadout.bonus`.
 */
export type PassiveRule = 'transcendance' | 'contagion';

export interface Passive {
  id: number;
  /**
   * Identifiant lu par les tests et par le code (grep `name`) — jamais montre
   * au joueur. Sans accent, comme tous les identifiants du depot.
   */
  name: string;
  /**
   * Ce que l'ECRAN montre : carte de draft, colonne de PV, infobulle bloquee
   * (etape 10, revue finale). `name` sert d'identifiant partout ailleurs — le
   * changer casserait les lectures par nom — donc l'affichage passe par ce
   * champ separe, accentue et capitalise, jamais par `name` directement.
   */
  label: string;
  /** Bonus apporte par CHAQUE carte prise (voir la doc de `PassiveKind`) — jamais un total cumule. */
  magnitude: number;
  kind: PassiveKind;
  /**
   * Le palier qui lui est RESERVE. Absent : carte ordinaire, qui ne sort que
   * sur un emplacement commun ou rare.
   *
   * ⚠️ **Remplace le booleen « exclusivement legendaire » de l'etape 10.** Il
   * ne pouvait pas dire « epique », et surtout il laissait la REGLE du x1 dans
   * `cards.ts` au lieu de la mettre dans la table des raretes.
   */
  tier?: PassiveTier;
  /**
   * Ce que la carte COUTE, dans les memes genres que ce qu'elle donne
   * (etape 13, §3.1). `Loadout.bonus` le retranche.
   *
   * ⚠️ **Une magnitude POSITIVE qui se retranche**, pas une magnitude negative
   * qui s'ajoute : la carte dit « je coute 40 PV max », et l'ecran l'affiche
   * tel quel. Un signe porte par la donnee se perdrait au premier affichage.
   */
  malus?: { kind: PassiveKind; magnitude: number };
  /**
   * La regle que cette carte impose (voir `PassiveRule`). Absente : carte
   * ordinaire, lue par `Loadout.bonus`.
   *
   * ⚠️ **`kind`/`magnitude` restent requis mais DEVIENNENT INERTES** chez une
   * carte a regle : `maxHpOf` statue avant de lire `bonus('maxHp')`, qui ne
   * voit donc jamais cette carte. `kind: 'maxHp'`, `magnitude: 0` par
   * convention — le genre qu'elle concerne vraiment, un montant qui ne sert
   * jamais.
   */
  rule?: PassiveRule;
}

/**
 * L'index de cette table **est** l'identifiant (voir `PASSIVES` plus bas) :
 * ajouter un passif est du contenu, pas de l'architecture.
 */
const PASSIVE_DEFS: readonly Omit<Passive, 'id'>[] = [
  {
    // Points de vie maximum ajoutes par carte, en points bruts.
    name: 'vitalite',
    label: 'Vitalité',
    kind: 'maxHp',
    magnitude: 20,
  },
  {
    // Fraction de `Weapon.cooldownTicks` retiree par carte, appliquee a
    // chaque arme possedee (0.08 = -8 % de cadence par carte).
    name: 'cadence',
    label: 'Cadence',
    kind: 'fireRate',
    magnitude: 0.08,
  },
  {
    // Fraction de `Weapon.damage` ajoutee par carte, appliquee a chaque arme
    // possedee (0.10 = +10 % de degats par carte).
    name: 'puissance',
    label: 'Puissance',
    kind: 'damage',
    magnitude: 0.1,
  },
  {
    // Vitesse de deplacement ajoutee par carte, en pixels monde par seconde
    // (voir `PLAYER_SPEED`).
    name: 'fougue',
    label: 'Fougue',
    kind: 'speed',
    magnitude: 15,
  },
  {
    // Second passif de degats, magnitude differente de « puissance » : prouve
    // que `Loadout.bonus(kind)` (tache 2) somme a travers plusieurs passifs
    // distincts du meme `kind`, pas seulement les cartes d'un meme passif.
    name: 'acier',
    label: 'Acier',
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
    // ⚠️ **Baisse de 2 a 0,6 au playtest** (*« le bonus de regen est trop
    // fort »*) : a 2 PV/s, deux cartes rendaient une vie entiere en 25 s.
    name: 'regain',
    label: 'Regain',
    kind: 'regen',
    magnitude: 0.6,
  },
  // ---- Etape 10 : quatre passifs qui s'empilent SANS PLAFOND (§3) ----------
  {
    // Chance de critique ajoutee par carte, en fraction (0,04 = +4 points).
    // Lue par `critOf` (shared/firing.ts) a l'apparition du projectile, des
    // deux cotes ; la borne a 1 vit la-bas et nulle part ailleurs.
    name: 'precision',
    label: 'Précision',
    kind: 'critChance',
    magnitude: 0.04,
  },
  {
    // Ajoute au multiplicateur critique par carte (0,3 : x2 devient x2,3).
    // Emporte PAR PROJECTILE a son apparition (`Projectiles.critFactorAt`).
    name: 'ferocite',
    label: 'Férocité',
    kind: 'critDamage',
    magnitude: 0.3,
  },
  {
    // Crans de `UPGRADE.SALVO` ajoutes par carte a chaque arme de genre
    // `'tir'`, et a elles seules (`weaponUpgrades`, shared/firing.ts).
    name: 'volee',
    label: 'Volée',
    kind: 'salvo',
    magnitude: 1,
  },
  {
    // Crans de `UPGRADE.ZONE` ajoutes par carte a TOUTES les armes.
    name: 'ampleur',
    label: 'Ampleur',
    kind: 'zone',
    magnitude: 1,
  },
  // ---- Les passifs de PALIER, trois par palier reserve (etape 13, §2.2) ---
  // Chacun ne sort que sur un emplacement de SON palier — chaque palier a son
  // propre pool. Ce qui les distingue d'une commune n'est jamais leur
  // `kind` (voir le test « aucune carte de palier ne partage son genre ») :
  // Écho et Colosse touchent une MECANIQUE qu'aucune commune ne lit deja
  // (reactions, mise a l'echelle par les PV max) ; Contagion est une REGLE
  // (`rule`) ; Fournaise et Hâte funeste coutent un MALUS qu'aucune commune
  // ne porte.
  //
  // ⚠️ **Les deux premiers tenaient dans un seul tas a l'etape 10.** Le
  // palier les separe : un palier sans aucune carte ferait redescendre tous
  // ses emplacements, et aucun test ne pourrait plus rien y affirmer.
  {
    // +100 % des degats INSTANTANES des reactions que le porteur declenche
    // (`ReactionTrigger.by`), par carte. Serveur seul (`applyReactions`).
    name: 'echo',
    label: 'Écho',
    kind: 'echo',
    magnitude: 1,
    tier: 'epique',
  },
  {
    // Fraction de degats ajoutee par tranche de `COLOSSUS_HP_STEP` PV max
    // (0,01 = +1 % par 10 PV). Lue par `shotDamage`, des deux cotes.
    name: 'colosse',
    label: 'Colosse',
    kind: 'colossus',
    magnitude: 0.01,
    tier: 'epique',
  },
  {
    // ⚠️ Carte de REGLE (etape 13, tache 7) : AUCUN bonus/malus chiffre — voir
    // le docbloc de `PassiveRule`. `kind`/`magnitude` restent par convention
    // (inertes, jamais lus par `Loadout.bonus` pour cette carte) ; l'effet
    // vit dans `spreadMarkOnDeath` (`back/src/combat.ts`), appele quand
    // `Loadout.hasRule('contagion')` est vrai pour au moins un joueur.
    name: 'contagion',
    label: 'Contagion',
    kind: 'zone',
    magnitude: 0,
    tier: 'epique',
    rule: 'contagion',
  },
  {
    // ⚠️ Carte de REGLE (etape 13, tache 6) : ramene les PV max a
    // `TRANSCENDANCE_MAX_HP` (1) et ouvre a la place la reserve de
    // `SHIELD_POOL`, voir `maxHpOf`/`maxShieldOf` (shared/loadout.ts). `kind`
    // et `magnitude` sont inertes — la regle statue avant que `bonus('maxHp')`
    // ne soit meme lu.
    //
    // ⚠️ **Trois consequences assumees, pas des bugs :** Vitalite devient
    // inerte (elle releve un plafond force a 1), Regain aussi (il soigne des
    // PV plafonnes a 1), et tout debordement du bouclier tue — il ne reste
    // qu'un point de vie derriere. C'est le cout de la carte ; c'est pour ca
    // que la regeneration du bouclier (`SHIELD_REGEN_PER_SEC`) est genereuse.
    name: 'transcendance',
    label: 'Transcendance',
    kind: 'maxHp',
    magnitude: 0,
    tier: 'legendaire',
    rule: 'transcendance',
  },
  {
    // Molettes de playtest : +60 % de degats pour 40 PV max. `kind: 'damage'`
    // est volontairement le MEME genre que « puissance »/« acier » — c'est ce
    // qui fait lire ce bonus par la meme formule (`shotDamage`), sans code
    // neuf — le malus de `maxHp` est ce qui la distingue d'une commune, pas
    // son genre.
    name: 'fournaise',
    label: 'Fournaise',
    kind: 'damage',
    magnitude: 0.6,
    tier: 'legendaire',
    malus: { kind: 'maxHp', magnitude: 40 },
  },
  {
    // Molettes de playtest : la recharge de moitie, les degats subis de
    // moitie en plus. L'armure negative mord les QUATRE sources, parce que
    // `hurtPlayer` est le point de passage unique (tache 3). Meme
    // raisonnement que Fournaise pour `kind: 'fireRate'`.
    name: 'hate-funeste',
    label: 'Hâte funeste',
    kind: 'fireRate',
    magnitude: 0.5,
    tier: 'legendaire',
    malus: { kind: 'armor', magnitude: 0.5 },
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
