/**
 * Le catalogue des passifs. Comme `archetypes.ts` et `weapons.ts` : l'index
 * dans le tableau **est** l'identifiant, rien a synchroniser entre serveur et
 * clients.
 *
 * Modele Risk of Rain : un passif ne monte jamais de niveau, il **s'empile**
 * (`Loadout.addPassive`). L'etalage n'exclut donc **jamais** un passif deja
 * possede, ce qui fait du conflit le regime normal du draft.
 */

/**
 * La grandeur mesurable qu'un passif fait varier.
 *
 * Restreint a des nombres mesurables ailleurs dans le jeu, pour qu'un test
 * puisse verifier qu'empiler deux cartes double bien le bonus applique.
 *
 * ⚠️ **`regen` agit A CHAQUE TICK** : les autres modulent une grandeur lue au
 * moment ou elle sert, celui-ci MUTE `PlayerState.hp`. Il vit donc dans
 * `Room.step` et nulle part ailleurs : `hp` est arbitre par le serveur seul,
 * et une regeneration appliquee des deux cotes ferait diverger deux barres de
 * vie.
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
  // Partage avec la boutique (`BonusKind`) et le combat (`p.armor`). Une
  // carte ne s'en sert que pour un MALUS.
  'armor',
] as const;
export type PassiveKind = (typeof PASSIVE_KINDS)[number];

/**
 * Les deux paliers reserves a des cartes de REGLE. Chacun a
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
 * ⚠️ **`contagion` suit le meme idiome pour une raison differente** :
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
   * Ce que l'ECRAN montre (carte de draft, colonne de PV, infobulle),
   * accentue et capitalise. L'affichage ne passe jamais par `name` : le
   * changer casserait les lectures par nom.
   */
  label: string;
  /** Bonus apporte par CHAQUE carte prise (voir la doc de `PassiveKind`) — jamais un total cumule. */
  magnitude: number;
  kind: PassiveKind;
  /**
   * Le palier qui lui est RESERVE. Absent : carte ordinaire, qui ne sort que
   * sur un emplacement commun ou rare.
   */
  tier?: PassiveTier;
  /**
   * Ce que la carte COUTE, dans les memes genres que ce qu'elle donne.
   * `Loadout.bonus` le retranche.
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
    // Second passif de degats : les tests s'en servent pour verifier que
    // `Loadout.bonus(kind)` somme a travers plusieurs passifs du meme `kind`.
    name: 'acier',
    label: 'Acier',
    kind: 'damage',
    magnitude: 0.06,
  },
  {
    // Points de vie rendus par carte et par SECONDE (`Room.step` divise par
    // `TICK_HZ`).
    //
    // Se soigner est un CHOIX DE CONSTRUCTION : « vitalite » ne donne son
    // delta qu'une fois, et rien d'autre ne fait remonter la vie.
    //
    // ⚠️ **Par seconde, pas par tick** : le nombre que le joueur lit sur la
    // carte doit etre celui qu'il ressent.
    //
    // A comparer aux 16 PV/s du contact (`CONTACT_DAMAGE` tous les
    // `CONTACT_INTERVAL_TICKS`) : la carte recompense le DESENGAGEMENT, elle
    // ne rend jamais un joueur immortel dans la horde.
    name: 'regain',
    label: 'Regain',
    kind: 'regen',
    magnitude: 0.6,
  },
  // ---- Quatre passifs qui s'empilent SANS PLAFOND --------------------------
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
    // Crans de `UPGRADE.SALVO` ajoutes par carte aux armes de genre `'tir'`
    // et `'frappe'`, et a elles seules (`weaponUpgrades`, shared/firing.ts).
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
  // ---- Les passifs de PALIER, trois par palier reserve ---------------------
  // Chacun ne sort que sur un emplacement de SON palier — chaque palier a son
  // propre pool. Ce qui les distingue d'une commune n'est jamais leur
  // `kind` (voir le test « aucune carte de palier ne partage son genre ») :
  // Écho et Colosse touchent une MECANIQUE qu'aucune commune ne lit deja
  // (reactions, mise a l'echelle par les PV max) ; Contagion est une REGLE
  // (`rule`) ; Fournaise et Hâte funeste coutent un MALUS qu'aucune commune
  // ne porte.
  //
  // ⚠️ Un palier sans aucune carte ferait redescendre tous ses emplacements,
  // et aucun test ne pourrait plus rien y affirmer.
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
    // ⚠️ Carte de REGLE : AUCUN bonus/malus chiffre — voir
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
    // ⚠️ Carte de REGLE : ramene les PV max a
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
    // moitie en plus. L'armure negative mord toutes les sources, parce que
    // `hurtPlayer` est le point de passage unique. Meme
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
