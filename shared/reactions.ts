import { MAX_ARMOR } from './archetypes';
import {
  ECLAT_DE_GEL_DAMAGE,
  FOURNEE_BURN_PER_TICK,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SUPRACONDUCTION_ARMOR_REDUCTION,
  SURCHAUFFE_BURN_PER_TICK,
  SURCHAUFFE_ZONE_LIFETIME_TICKS,
  VERGLAS_COLLISION_DAMAGE_PER_TICK,
  VERGLAS_INERTIA_DAMPING,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { packElementPair, zoneElement, zoneReaction } from './protocol';

/**
 * La table des reactions a effet SPECIFIQUE (tache 6 de l'etape 5b) : meme
 * motif que `ELEMENT_DEFS`, `WEAPONS` et `ARCHETYPES` — une donnee par
 * couple, pas un `switch` sur la paire.
 *
 * ⚠️ **Une paire ABSENTE de cette table n'est pas une erreur.** Elle rend
 * simplement le comportement GENERIQUE de `applyReactions` (le Choc thermique
 * de l'etape 5a : `REACTION_DAMAGE` dans `REACTION_RADIUS`, sans filtre ni
 * champ special) — c'est le cas de Braise+Givre aujourd'hui, la seule paire
 * des cinq de l'etape 5b (§5 de la spec) a rester sans effet specifique.
 *
 * ⚠️ **`id` empaquete le nibble de reaction de `ZoneField.kind`** (bits 3-6,
 * voir `packZoneKind`/`zoneReaction` dans `shared/protocol.ts`) — c'est la
 * meme valeur, jamais une seconde table a tenir synchrone. `postZone`
 * (`back/src/combat.ts`) l'y pose ; `zoneLifetimeTicks`/`zoneBurnPerTick`
 * ci-dessous l'en relisent.
 */
/**
 * Les silhouettes de champ (etape 8) — *« fais des zones de differentes
 * tailles, duree, forme »*.
 *
 * ⚠️ **Un NOM, jamais un dessin.** Le trace vit cote client
 * (`front/src/render/zone-renderer.ts`, qui en cuit une case d'atlas) ;
 * `shared/` n'a ni canevas ni `document`. Exactement le rapport que
 * `ProjectileShape` entretient avec ses peintres.
 *
 * ⚠️ **QUATRE familles pour quatorze reactions, pas quatorze silhouettes.**
 * Une forme par reaction aurait voulu dire quatorze traces a dessiner et a
 * tenir, pour une lecture que le joueur fait en un quart de seconde au sol. Ce
 * qu'il faut distinguer, c'est la FAMILLE d'effet — ce qui brule, ce qui
 * englue, ce qui eclate, ce qui fracture — et quatre suffisent a ca.
 */
export type ZoneShape = 'rond' | 'lobes' | 'etoile' | 'fracture';

export const REACTION = {
  /** Aucun effet de reaction specifique — le nibble de reaction a zero. */
  AUCUNE: 0,
  SURCHAUFFE: 1,
  EMBRASEMENT: 2,
  COURT_CIRCUIT: 3,
  SUPRACONDUCTION: 4,
  VERGLAS: 5,
  FOURNEE: 6,
  ECLAT_DE_GEL: 7,
  VAPORISATION: 8,
  ARC_CAUSTIQUE: 9,
  PARATONNERRE: 10,
  GEL_PROFOND: 11,
  MORTIER_VIF: 12,
  AVEUGLEMENT: 13,
  /**
   * Amalgame (Poix + Vif-argent, tache 7 de l'etape 5c) : la QUATORZIEME
   * reaction nommee, et la QUINZIEME valeur du nibble en comptant `AUCUNE`
   * (0) — le nibble de reaction fait 4 bits (`zoneReaction`/`packZoneKind`,
   * `shared/protocol.ts`), donc SEIZE valeurs au total. **Il en reste UNE**
   * (15) : une seizieme reaction nommee deborderait le nibble EN SILENCE
   * (`(reaction & 0x0f) << 3` tronque, il ne leve jamais) et demanderait un
   * octet de plus sur `ZoneField.kind` — hors de portee de cette etape (§0 :
   * « zero octet de plus sur le fil »). Voir le describe « invariant de
   * REACTION_DEFS » dans `reactions.test.ts`, qui derive cette borne de
   * `zoneReaction` elle-meme plutot que de l'ecrire en dur ici une seconde
   * fois.
   */
  AMALGAME: 14,
} as const;

export interface ReactionDef {
  /** La valeur empaquetee dans le nibble de reaction de `ZoneField.kind`. */
  readonly id: number;
  readonly name: string;
  /** Le couple d'elements, canonicalise par `packElementPair`. */
  readonly pair: number;
  /**
   * Degats par tick que la zone laissee par cette reaction inflige
   * D'ELLE-MEME, independamment de toute marque (0 : la zone ne brule pas).
   *
   * ⚠️ **Ne PEUT PAS se lire generiquement au site d'application, contrairement
   * a `Element.burnPerTick`.** Le champ que laisse une reaction porte
   * l'element du DECLENCHEUR (voir `ReactionTrigger.element`), qui varie selon
   * l'ordre d'arrivee des deux elements — pour Surchauffe (Braise + Foudre) ca
   * peut etre Foudre, dont `Element.burnPerTick` est nul. Le taux de brulure
   * de la zone doit donc venir du TYPE DE REACTION, jamais de l'element.
   */
  readonly zoneBurnPerTick: number;
  /**
   * Duree de vie de la zone laissee par cette reaction, en ticks (0 : la
   * duree generique `ZONE_LIFETIME_TICKS` s'applique).
   */
  readonly zoneLifetimeTicks: number;
  /** Rayon d'un effet geometrique instantane a la resolution (0 : n/a). */
  readonly radius: number;
  /** Degats d'un effet geometrique ou en chaine instantane (0 : n/a). */
  readonly damage: number;
  /**
   * Facteur de vitesse propre a la zone laissee par cette reaction (1 :
   * aucun effet propre — la Supraconduction, tache 7 de l'etape 5b, est la
   * seule a en porter un aujourd'hui).
   *
   * ⚠️ **Combine par MINIMUM avec `Element.slowFactor` de l'element porte par
   * le `kind`, jamais lu seul.** Voir `zoneSlowFactor` ci-dessous : le nibble
   * d'element d'une zone de reaction porte celui du DECLENCHEUR
   * (`ReactionTrigger.element`), qui varie selon l'ordre d'arrivee des deux
   * elements — lire `elementOf(zoneElement(kind)).slowFactor` seul rendrait
   * une reponse different selon cet ordre, jamais la meme.
   */
  readonly zoneSlowFactor: number;
  /**
   * Armure SOUSTRAITE (jamais multipliee) a qui se tient dans la zone
   * laissee par cette reaction (0 : aucun effet).
   *
   * ⚠️ **N'a PAS d'equivalent porte par `Element`, contrairement a
   * `zoneSlowFactor`.** Rien a combiner avec le nibble d'element ici : voir
   * `zoneArmorReduction` ci-dessous.
   */
  readonly zoneArmorReduction: number;
  /**
   * Facteur d'amplification des degats propre a la reaction, applique a qui
   * se tient dans la zone laissee (1 : aucun effet propre — Mortier vif,
   * tache 6 de l'etape 5c, est la seule a en porter un aujourd'hui).
   *
   * ⚠️ **La piece manquante que cette tache ajoute — verifiee, pas supposee
   * absente : `grep -c zoneDamageAmp shared/reactions.ts` rendait 0 avant
   * cette tache, alors que `zoneSlowFactor`, `zoneArmorReduction` et
   * `zoneFieldSign` existaient deja tous.** Sans ce champ, une reaction dont
   * l'un des deux elements porte un `Element.damageAmp` non neutre (la Poix,
   * 1,5) heriterait l'amplification de l'element du DECLENCHEUR — non
   * neutre une fois sur deux seulement, selon l'ordre d'arrivee. Voir
   * `zoneDamageAmpTotal` ci-dessous, qui la combine avec `Element.damageAmp`
   * EXACTEMENT comme `zoneArmorReductionTotal` combine `zoneArmorReduction`
   * avec `Element.armorReduction` — meme forme, cree en une seule fois ici
   * plutot qu'en deux temps (`zoneArmorReduction` puis
   * `zoneArmorReductionTotal` sont nees a des taches differentes, 5b puis
   * 5c) : aucune lecture NUE de ce champ seul n'est exposee, rien n'en a
   * besoin.
   *
   * ⚠️ **Combine par MAXIMUM, jamais une somme ni un produit — decision de
   * JEU, pas contrainte arithmetique, exactement la meme raison que
   * `zoneArmorReductionTotal` et le maximum de `ZoneField.ampAt` lui-meme
   * (deja en place depuis la tache 4 de l'etape 5b pour deux zones qui se
   * recouvrent).** Deux sources d'amplification ne s'additionnent pas.
   */
  readonly zoneDamageAmp: number;
  /**
   * Facteur de conservation de la vitesse tenue dans la zone laissee par
   * cette reaction (1 : aucun effet propre — Verglas, tache 8 de l'etape 5b,
   * est la seule a en porter un aujourd'hui). Lu par
   * `Horde#recomputeSteering` (`shared/horde.ts`), qui VOYAGE des deux cotes
   * du fil.
   *
   * ⚠️ **AUCUN equivalent porte par `Element`, contrairement a
   * `zoneSlowFactor` — rien a combiner avec le nibble d'element ici.**
   * L'inertie est une propriete de la REACTION seule : deriver du
   * declencheur (Givre OU Poix selon l'ordre d'arrivee) n'aurait aucun sens,
   * `Element` ne portant aucune notion de friction. Voir
   * `zoneInertiaDamping` ci-dessous.
   */
  readonly zoneInertiaDamping: number;
  /**
   * Degats par tick entre DEUX ennemis qui se tiennent tous deux dans la
   * zone laissee par cette reaction et sont trop proches l'un de l'autre (0 :
   * aucun effet — Verglas, tache 8 de l'etape 5b, est la seule a en porter
   * un aujourd'hui, « ils se percutent »).
   *
   * ⚠️ **Un DEGAT, donc lu SEULEMENT cote serveur** (`resolveVerglasCollisions`,
   * `back/src/combat.ts`), aucune contrainte de replication — le client ne
   * prononce jamais de degat (§2), seules les morts qui en resultent
   * voyagent, et elles voyagent deja par `DEATHS`.
   */
  readonly zoneCollisionDamage: number;
  /**
   * Signe propre a la zone laissee par cette reaction (etape 5c, tache 1) :
   * `+1` aucun effet propre, `-1` inverse la direction du champ. Aucune
   * ligne ne porte `-1` aujourd'hui — la fuite de la Chaux vient de
   * `Element.fieldSign`, lu ici via `zoneFieldSign` ci-dessous.
   *
   * ⚠️ **Meme forme que `zoneSlowFactor` : un PLANCHER que la reaction peut
   * poser pour garantir l'effet quel que soit l'ordre d'arrivee, pas une
   * duplication de l'element.** Aucune des cinq reactions actuelles ne pair
   * la Chaux — celles qui le feront (Fournee, Eclat de gel, Arc caustique,
   * Mortier vif, hors du perimetre de cette tache) devront reprendre ce
   * champ si leur zone doit fuir QUEL QUE SOIT l'element porte par le
   * nibble, exactement comme Verglas l'a fait pour `zoneSlowFactor`.
   */
  readonly zoneFieldSign: number;
  /**
   * Vrai si la zone laissee par cette reaction COMPTE COMME DU VIF-ARGENT
   * pour ses DEUX effets secondaires structurels — la liaison
   * (`linkedNeighbours`, `shared/links.ts`, §3 de la spec : « la meme zone
   * de Vif-argent ») et le rayon de touche elargi (`ZoneField.
   * hitRadiusBonusAt`, `shared/zones.ts`, §4 : « un ennemi dans une zone de
   * Vif-argent »). UN SEUL critere, DEUX consommateurs — ce champ a change
   * de nom deux fois pour le dire :
   *
   * ⚠️ **Correctif en TROIS temps.**
   *
   * 1. Un premier correctif derivait les deux effets de la paire (`pair`
   *    contient `ELEMENT.VIF_ARGENT` ?, `zoneInvolvesVifArgent`, retiree).
   *    Il reparait le bug mesure (`zonesLiantesVues = 0` partout), mais
   *    faisait les deux pour LES CINQ paires du Vif-argent — y compris Gel
   *    profond et Aveuglement, qui avaient une entree ECRITE dans cette
   *    table (tache 6) decidant l'inverse pour la liaison, en citant le §5
   *    de la spec : Gel profond est « vitesse nulle dans la zone »,
   *    Aveuglement est « la fuite », ni l'un ni l'autre ne mentionne la
   *    liaison NI le rayon de touche. Deriver de la paire renversait cette
   *    decision EN SILENCE, pour les deux effets.
   * 2. Un second correctif a cree `zoneLinks`, un champ EPINGLE mais
   *    SEULEMENT consulte par la liaison : `hitRadiusBonusAt` est reste sur
   *    `zoneInvolvesVifArgent` (la paire), donc sur LES CINQ — Gel profond
   *    elargissait le rayon de touche mais ne liait plus. Personne n'a
   *    choisi cette divergence ; elle vient d'avoir corrige un seul des
   *    deux consommateurs.
   * 3. Celui-ci RENOMME `zoneLinks` en `zoneVifArgent` SANS changer ses
   *    valeurs, et fait lire ce MEME champ par `hitRadiusBonusAt` aussi.
   *    `zoneInvolvesVifArgent` est retiree : il n'y a plus deux predicats a
   *    tenir synchrones, un seul champ tranche pour les deux usages.
   *
   * ⚠️ **Seules les TROIS reactions qui ont BESOIN du Vif-argent le
   * fournissent elles-memes** : Vaporisation (degats en rayon autour de
   * chaque lie), Paratonnerre (chaine qui prefere les lies), Amalgame
   * (partage les degats entre lies). Gel profond et Aveuglement restent a
   * `false` pour les DEUX effets — leur effet propre (vitesse nulle / fuite)
   * ne depend d'aucun voisin, et rien dans leur entree de `REACTION_DEFS`
   * (voir plus haut) ne leur attribue le rayon de touche elargi non plus.
   *
   * ⚠️ **Un CHAMP de la table, pas un dérivé de l'element — donc ORDRE-
   * INDEPENDANT PAR CONSTRUCTION, sans canonicalisation a invoquer.** Le
   * nibble d'element d'une zone de reaction porte le declencheur (Vif-argent
   * OU son partenaire selon l'ordre d'arrivee des deux projectiles) — mais
   * `zoneVifArgent` est une propriete de la LIGNE de `REACTION_DEFS`, lue par
   * `id` (`zoneReaction(kind)`), jamais par l'element : le probleme d'ordre
   * que l'ancien filtre visait a resoudre ne se pose plus du tout ici.
   */
  readonly zoneVifArgent: boolean;
  /**
   * Rayon du champ que cette reaction laisse, en pixels monde. `0` : le rayon
   * generique `ZONE_RADIUS`.
   *
   * ⚠️ **Meme forme et meme raison que `zoneLifetimeTicks` juste au-dessus** —
   * zero veut dire « rien de particulier », et c'est la ligne ABSENTE qui est
   * le cas courant. Les deux cotes du fil decodent le meme octet de `kind` et
   * obtiennent le meme rayon : rien de plus ne transite (voir `zoneRadius`).
   *
   * ⚠️ **Le rayon DESSINE suit celui-ci**, jamais l'inverse : `ZoneRenderer`
   * met l'echelle de chaque disque sur ce que la regle dit, parce que « le bord
   * dit toujours la verite » (tache 16). Une zone deux fois plus large qui se
   * dessinerait pareil mentirait sur ce qu'elle ralentit.
   */
  readonly zoneRadius: number;
  /**
   * La silhouette du champ — voir `ZoneShape`.
   *
   * ⚠️ **Elle n'a AUCUN effet de jeu** : la regle reste un disque de
   * `zoneRadius`, et l'encre reste dans ce disque (`RIM_MIN`). Ce que la forme
   * dit, c'est de QUELLE reaction vient le champ, la ou la teinte dit son
   * element — exactement le partage que `Weapon.look` fait entre la forme et
   * la teinte d'un projectile.
   */
  readonly zoneShape: ZoneShape;
}

/**
 * ⚠️ **Exportee depuis la tache 7 de l'etape 5c, pour l'invariant de table**
 * (`reactions.test.ts`) — jusque la, seuls `reactionForPair`/`reactionOfId`
 * en sortaient une ligne a la fois. Verifier « tous les `id` uniques et
 * `<= 15` » ou « tous les `pair` uniques » a la main, ligne par ligne, est
 * exactement l'enumeration manuelle que la tache 7 remplace — voir son
 * rapport. Ca ne change rien au motif « un lookup, jamais un switch sur
 * `pair` » : cette table reste la SEULE a connaitre la valeur numerique d'un
 * couple, l'export ne fait qu'exposer ses lignes a un test qui les compte.
 */
export const REACTION_DEFS: readonly ReactionDef[] = [
  {
    // Surchauffe (Braise + Foudre) : une zone qui brule d'elle-meme, plus
    // fort et plus longtemps que le champ generique — voir
    // `resolveBurn` (back/src/combat.ts) et `zoneLifetimeTicks` ci-dessous.
    id: REACTION.SURCHAUFFE,
    name: 'surchauffe',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.FOUDRE),
    zoneBurnPerTick: SURCHAUFFE_BURN_PER_TICK,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    // Ni ralentissement ni reduction d'armure propres : Surchauffe agit par
    // la brulure, pas par le deplacement ou la defense.
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.8),
    zoneShape: 'etoile',
  },
  {
    // Embrasement (Braise + Poix) : degats instantanes a tout ennemi POISSE
    // dans un rayon — une seule passe geometrique, voir `damageInRadius`
    // (`markFilter`, back/src/combat.ts). Reutilise le rayon et le degat
    // generiques de la reaction (comme le Choc thermique) : l'ecart avec le
    // generique est la SELECTIVITE (poisses seulement), pas l'intensite —
    // aucune donnee de jeu ne motive un second chiffre.
    id: REACTION.EMBRASEMENT,
    name: 'embrasement',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 0.7),
    radius: REACTION_RADIUS,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.3),
    zoneShape: 'etoile',
  },
  {
    // Court-circuit (Foudre + Poix) : `chainTargets` (shared/chain.ts),
    // jumps non borne, tant que les cibles restent poissees — voir
    // `chainWhilePoisoned` (back/src/combat.ts). Meme degat generique que la
    // reaction, par saut.
    id: REACTION.COURT_CIRCUIT,
    name: 'court-circuit',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 0.55),
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.65),
    zoneShape: 'fracture',
  },
  {
    // Supraconduction (Givre + Foudre, tache 7 de l'etape 5b) : vitesse
    // NULLE et armure rabotee dans la zone laissee — ni brulure ni effet
    // geometrique instantane, donc les quatre premiers champs restent a leur
    // valeur neutre. Voir `Horde#computeSlow` (shared/horde.ts, le MINIMUM
    // qui la fait voyager) et `armureA` (back/src/combat.ts, le MAXIMUM qui
    // ne la fait pas voyager) pour les deux chemins qui la lisent.
    id: REACTION.SUPRACONDUCTION,
    name: 'supraconduction',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.FOUDRE),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: 0,
    // 0 : gel total, quel que soit l'element porte par le nibble (Givre OU
    // Foudre selon l'ordre d'arrivee du declencheur) — voir `zoneSlowFactor`.
    zoneSlowFactor: 0,
    zoneArmorReduction: SUPRACONDUCTION_ARMOR_REDUCTION,
    zoneDamageAmp: 1,
    // Ni inertie ni collision propres : la Supraconduction agit par le gel,
    // pas par la perte de controle.
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.15),
    zoneShape: 'fracture',
  },
  {
    // Verglas (Givre + Poix, tache 8 de l'etape 5b) : friction REDUITE dans
    // la zone laissee — les ennemis gardent leur trajectoire au lieu de la
    // corriger (`zoneInertiaDamping`, `Horde#recomputeSteering`, ce qui
    // VOYAGE) et se percutent en glissant (`zoneCollisionDamage`,
    // `resolveVerglasCollisions` dans `back/src/combat.ts`, ce qui ne
    // voyage PAS — un degat, serveur seul). Ni brulure ni effet geometrique
    // instantane propres.
    id: REACTION.VERGLAS,
    name: 'verglas',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.POIX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 1.4),
    radius: 0,
    damage: 0,
    // ⚠️ **EXPLICITE, jamais neutre (1) — voir le docbloc de `zoneSlowFactor`
    // plus bas.** Un facteur neutre laisserait l'element du DECLENCHEUR
    // (Givre OU Poix selon l'ordre d'arrivee) fuiter au travers du minimum :
    // min(0,6, 1) = 0,6 si Givre declenche, min(1, 1) = 1 si Poix declenche —
    // la meme Verglas glisserait ou pas selon quel projectile a touche en
    // second. Fixe a la valeur de Givre (jamais recopiee — voir
    // `elementOf`) : le minimum rend alors 0,6 dans les DEUX cas
    // (min(0,6, 0,6) = 0,6, min(1, 0,6) = 0,6), ni plus ni moins que le
    // Givre seul — Verglas n'AJOUTE aucun ralentissement, elle en garantit
    // un, quel que soit l'ordre.
    zoneSlowFactor: elementOf(ELEMENT.GIVRE).slowFactor,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: VERGLAS_INERTIA_DAMPING,
    zoneCollisionDamage: VERGLAS_COLLISION_DAMAGE_PER_TICK,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.45),
    zoneShape: 'lobes',
  },
  {
    // Fournee (Braise + Chaux, tache 4 de l'etape 5c) : la combustion double
    // (`FOURNEE_BURN_PER_TICK`, deux fois `SURCHAUFFE_BURN_PER_TICK`) ET
    // l'armure tombe a zero dans la zone (`zoneArmorReduction: MAX_ARMOR`,
    // voir `armureA` dans `back/src/combat.ts` : borne par le bas a zero, donc
    // MAX_ARMOR suffit a annuler n'importe quelle armure d'archetype, jamais
    // superieure a MAX_ARMOR elle-meme).
    //
    // ⚠️ **`zoneArmorReduction` ET `zoneFieldSign` sont EXPLICITES, jamais
    // heritees de l'element — le piege des DEUX planchers.** Cette paire
    // apparie la Chaux, qui porte DEUX proprietes non neutres
    // (`armorReduction` et `fieldSign: -1`, voir `shared/elements.ts`) : le
    // nibble d'element de la zone porte le DECLENCHEUR (Braise OU Chaux selon
    // l'ordre d'arrivee), donc lire l'une ou l'autre grandeur SEULE au
    // travers de l'element rendrait Fournee corrosive une fois sur deux
    // (`zoneArmorReductionTotal` combine par MAXIMUM) et fuyante une fois sur
    // deux (`zoneFieldSign` combine par MINIMUM). `MAX_ARMOR` domine
    // n'importe quelle contribution de l'element (`CHAUX_ARMOR_REDUCTION`
    // dessous), et `elementOf(ELEMENT.CHAUX).fieldSign` (-1) domine le
    // neutre (+1) de la Braise par le minimum : les deux plafonds/planchers
    // rendent le resultat le MEME quel que soit l'ordre. Voir le test
    // « Fournee ne depend pas de l'ordre d'arrivee (armure ET fuite) »,
    // `shared/reactions.test.ts`.
    id: REACTION.FOURNEE,
    name: 'fournee',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.CHAUX),
    zoneBurnPerTick: FOURNEE_BURN_PER_TICK,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 1,
    zoneArmorReduction: MAX_ARMOR,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.1),
    zoneShape: 'rond',
  },
  {
    // Eclat de gel (Givre + Chaux, tache 4 de l'etape 5c) : degats bruts
    // massifs sur la SEULE cible qui declenche la reaction (`ECLAT_DE_GEL_DAMAGE`),
    // pas un effet de zone — voir la branche dediee d'`applyReactions`
    // (`back/src/combat.ts`), qui lit `damage` directement au lieu du
    // balayage generique. `radius: 0` documente ce choix : AUCUN effet
    // geometrique, contrairement a Embrasement.
    //
    // ⚠️ **TROIS planchers EXPLICITES, pas deux — correction de la revue.**
    // `zoneArmorReduction` ET `zoneFieldSign` restent explicites MEME pour
    // une reaction dont l'effet reel n'est PAS porte par la zone : `postZone`
    // (`back/src/combat.ts`) pose une zone pour CHAQUE declencheur, sans
    // exception pour les reactions « degat seul » — la zone laissee par Eclat
    // de gel existe donc bel et bien, et son element porte le DECLENCHEUR
    // (Givre OU Chaux selon l'ordre). La reduction choisie est
    // `elementOf(ELEMENT.CHAUX).armorReduction` — pas `MAX_ARMOR` — parce
    // qu'Eclat de gel ne PRETEND a aucun effet d'armure propre (a la
    // difference de Fournee) : le plancher garantit seulement ce qu'une Chaux
    // SEULE laisserait deja, ni plus ni moins, quel que soit l'ordre.
    //
    // ⚠️ **La revue a trouve la TROISIEME : le Givre, l'AUTRE moitie du
    // couple, porte lui aussi une propriete non neutre (`slowFactor` = 0,6),
    // et `zoneSlowFactor` la laissait a 1 (neutre) — donc HERITEE de
    // l'element, pas plancheee.** `zoneSlowFactor(kind) = min(elementFactor,
    // reactionFactor)` : avec `reactionFactor` neutre, le Givre glace la zone
    // (0,6) s'il est arrive en SECOND, et la Chaux ne glace RIEN (1) si elle
    // est arrivee en second — la meme Eclat de gel ralentirait ou pas selon
    // l'ordre des deux projectiles, exactement le piege que ce module existe
    // pour fermer. Corrige en reprenant le plancher de Verglas
    // (`elementOf(ELEMENT.GIVRE).slowFactor`, jamais recopie) : « la cible
    // explose en eclats » (§6.4) garde la morsure du froid quel que soit
    // l'ordre, plutot que de la perdre a l'arbitraire d'un ordre de tir. Voir
    // le test « Eclat de gel ne depend plus de l'ordre d'arrivee (armure,
    // fuite ET ralentissement) », `shared/reactions.test.ts`.
    //
    // ⚠️ **Regle generale (que la revue a elargie deux fois) : une reaction
    // doit plancher EXPLICITEMENT toute grandeur de zone dans laquelle L'UN
    // OU L'AUTRE de ses deux elements est non neutre** — pas seulement celles
    // que porte la Chaux. Fournee (Braise + Chaux) n'a besoin d'AUCUN
    // troisieme plancher pour `zoneBurnPerTick` : cette grandeur ne combine
    // JAMAIS avec l'element (voir son docbloc plus haut, `zoneBurnPerTick`
    // ne lit que `ReactionDef.zoneBurnPerTick`, jamais
    // `elementOf(...).burnPerTick`) — la Braise n'a donc structurellement
    // rien a fuiter ici, et la ligne de Fournee est deja explicite (elle ne
    // pouvait pas faire autrement : il n'y a pas de valeur « neutre heritee »
    // possible pour ce champ, `?? 0` est le seul secours).
    id: REACTION.ECLAT_DE_GEL,
    name: 'eclat-de-gel',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: ECLAT_DE_GEL_DAMAGE,
    zoneSlowFactor: elementOf(ELEMENT.GIVRE).slowFactor,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.7),
    zoneShape: 'etoile',
  },
  {
    // Vaporisation (Braise + Vif-argent, tache 5 de l'etape 5c) : degats
    // dans un rayon autour de chaque ennemi LIE au declencheur (§5 de la
    // spec : « degats dans un rayon autour des ennemis lies », porte par la
    // GEOMETRIE — voir la branche dediee d'`applyReactions`,
    // `back/src/combat.ts`, qui reutilise `damageInRadius` ET
    // `linkedNeighbours` sans en reecrire un second de chacune). Meme choix
    // qu'Embrasement/Court-circuit : `radius`/`damage` reutilisent les
    // grandeurs GENERIQUES de la reaction, l'ecart avec le Choc thermique
    // etant le CHOIX DES CENTRES (un par ennemi lie), jamais l'intensite —
    // aucune donnee de jeu ne motive un second chiffre.
    //
    // ⚠️ **AUCUN plancher requis — verifie, pas suppose.** Braise n'est non
    // neutre QUE sur `burnPerTick` (0,1 par tick), qui ne combine JAMAIS
    // avec l'element (voir le docbloc de `zoneBurnPerTick` : elle ne lit
    // que `ReactionDef.zoneBurnPerTick`, jamais `elementOf(...).burnPerTick`)
    // — rien a fuiter ici structurellement, meme raisonnement que la ligne
    // de Fournee pour ce meme champ. Vif-argent, lui, est NEUTRE sur les
    // CINQ grandeurs de cette table (voir son entree dans `ELEMENT_DEFS`,
    // `shared/elements.ts` : « tous les effets de CETTE table a leur
    // neutre »). Aucun des deux elements de ce couple ne porte donc de
    // grandeur COMBINANTE non neutre — contrairement a Arc caustique
    // (Foudre + Chaux) juste en dessous, dont la Chaux en porte DEUX.
    id: REACTION.VAPORISATION,
    name: 'vaporisation',
    pair: packElementPair(ELEMENT.BRAISE, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 1.2),
    radius: REACTION_RADIUS,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: true,
    zoneRadius: Math.round(ZONE_RADIUS * 1.25),
    zoneShape: 'lobes',
  },
  {
    // Arc caustique (Foudre + Chaux, tache 5 de l'etape 5c) : `chainTargets`
    // (tache 2) INCHANGEE, meme forme que la chaine de Foudre ordinaire
    // (`CHAIN_RADIUS`/`CHAIN_JUMPS`) — degat generique par saut, PLUS une
    // pose de zone corrosive a CHAQUE cible touchee (§5 : « la chaine
    // laisse un champ corrosif a chaque saut »). Voir la branche dediee
    // d'`applyReactions` (`back/src/combat.ts`), qui reappelle `postZone`
    // (le SEUL createur de zones) a la position de chaque maillon.
    //
    // ⚠️ **`zoneArmorReduction` ET `zoneFieldSign` sont EXPLICITES, jamais
    // heritees de l'element — le piege des DEUX planchers, comme Fournee et
    // Eclat de gel avant elle.** Cette paire apparie la Chaux, qui porte
    // DEUX proprietes non neutres (`armorReduction` et `fieldSign: -1`,
    // voir `shared/elements.ts`) : le nibble d'element de la zone (posee a
    // CHAQUE maillon, y compris le premier) porte le DECLENCHEUR (Foudre OU
    // Chaux selon l'ordre d'arrivee), donc lire l'une ou l'autre grandeur
    // SEULE au travers de l'element rendrait Arc caustique corrosive une
    // fois sur deux et fuyante une fois sur deux. Foudre, l'autre moitie du
    // couple, est NEUTRE sur les cinq grandeurs de cette table (voir son
    // entree dans `ELEMENT_DEFS`) : aucun troisieme plancher n'est donc
    // necessaire ici, a la difference d'Eclat de gel (Givre + Chaux), dont
    // le Givre porte lui aussi un `slowFactor` non neutre.
    //
    // ⚠️ **`SUPRACONDUCTION_ARMOR_REDUCTION`, REUTILISEE et non recopiee —
    // pas un troisieme chiffre arbitraire.** Arc caustique est, comme la
    // Supraconduction, une reaction a DEUX elements dont l'armure est
    // l'effet propre principal (contrairement a Fournee, qui va jusqu'a
    // `MAX_ARMOR`, et a Eclat de gel, dont l'armure n'est qu'un plancher
    // pour un effet qui n'est pas le sien) : reprendre la meme constante
    // evite d'inventer un reglage de jeu non motive, exactement le
    // raisonnement que Verglas applique deja a `zoneSlowFactor`
    // (`elementOf(ELEMENT.GIVRE).slowFactor`, jamais recopie).
    id: REACTION.ARC_CAUSTIQUE,
    name: 'arc-caustique',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: SUPRACONDUCTION_ARMOR_REDUCTION,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.85),
    zoneShape: 'fracture',
  },
  {
    // Paratonnerre (Foudre + Vif-argent, tache 5 de l'etape 5c) :
    // `chainTargets` (tache 2) INCHANGEE, `exclude` pre-rempli des ennemis
    // NON LIES au declencheur — exactement la forme que Court-circuit a
    // prise pour les non-poisses (tache 6 de l'etape 5b, `chainWhilePoisoned`).
    // Voir `chainPreferringLinked` dans `back/src/combat.ts`.
    //
    // ⚠️ **`CHAIN_JUMPS`/`CHAIN_RADIUS`, PAS un plafond de cout dedie comme
    // `COURT_CIRCUIT_MAX_JUMPS`.** Paratonnerre reste la chaine de Foudre
    // ORDINAIRE (3 sauts) qui PREFERE les lies — le §5 de la spec ne
    // demande ni une propagation sans limite ni un rayon elargi, seulement
    // une PREFERENCE de cible. `jumps` est deja petit, un second plafond
    // n'a donc rien a borner ici.
    //
    // ⚠️ **AUCUN plancher requis — verifie, pas suppose.** Foudre ET
    // Vif-argent sont tous deux NEUTRES sur les cinq grandeurs de cette
    // table (voir leurs entrees dans `ELEMENT_DEFS`) : ce couple ne porte
    // structurellement rien a fuiter, contrairement a Arc caustique
    // au-dessus.
    id: REACTION.PARATONNERRE,
    name: 'paratonnerre',
    pair: packElementPair(ELEMENT.FOUDRE, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 1.6),
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: true,
    zoneRadius: Math.round(ZONE_RADIUS * 0.6),
    zoneShape: 'fracture',
  },
  {
    // Gel profond (Givre + Vif-argent, tache 6 de l'etape 5c) : vitesse
    // NULLE dans la zone laissee, EXACTEMENT comme la Supraconduction — la
    // DUREE la distingue, pas l'intensite (§5 de la spec : « plus forte ou
    // plus longue que Supraconduction » ; `slowFactor` 0 est deja un
    // plancher ABSOLU, rien n'est « plus fort » que zero, donc la duree est
    // le SEUL levier qui reste).
    //
    // ⚠️ **`zoneLifetimeTicks` REUTILISE `SURCHAUFFE_ZONE_LIFETIME_TICKS`
    // (135 ticks, 4,5 s a `TICK_HZ`), pas un troisieme chiffre arbitraire.**
    // La Supraconduction ne porte aucune duree propre (`zoneLifetimeTicks: 0`
    // dans son entree ci-dessus) : sa zone vit la duree GENERIQUE
    // (`ZONE_LIFETIME_TICKS`, 90 ticks, 3 s). N'importe quelle duree
    // strictement superieure a 90 suffirait a satisfaire « plus longue » ;
    // reprendre le multiplicateur deja etabli par Surchauffe (x1,5) evite
    // d'inventer un second reglage non motive.
    //
    // ⚠️ **Vif-argent est NEUTRE sur les CINQ grandeurs combinantes de cette
    // table (voir son entree dans `ELEMENT_DEFS`) : seul le Givre porte une
    // grandeur non neutre ici (`slowFactor`, 0,6).** `zoneSlowFactor: 0` est
    // deja un plancher ABSOLU (`min(x, 0) = 0` quel que soit `x`) qui domine
    // le Givre comme le Vif-argent : `zoneArmorReduction` et `zoneFieldSign`
    // restent donc neutres, VERIFIE par la table plutot que suppose — cette
    // paire n'a besoin d'aucun autre plancher.
    //
    // ⚠️ **Le pare-feu de la tache 3 est SUPPRIME (revue post-tache 9) — la
    // decision TRANCHEE ci-dessous est RENVERSEE, pas heritee en silence.**
    // Cette entree decidait que Gel profond ne devait NI lier NI elargir le
    // rayon de touche, au motif que le §5 de la spec decrit son effet comme
    // « vitesse nulle dans la zone » SEUL — en s'appuyant sur le filtre de
    // la tache 3 (`zoneReaction(kind) === 0`) comme mecanisme d'exclusion.
    // Ce filtre s'est revele MORT en production pour toute reaction qui
    // apparie le Vif-argent : `postZone` (`back/src/combat.ts`) est le SEUL
    // createur de zones, et les CINQ paires du Vif-argent sont TOUTES
    // nommees dans cette table — une zone « pure » (reaction nulle) ne
    // peut donc jamais exister en jeu, et le filtre excluait TOUT, en
    // silence (mesure a `zonesLiantesVues = 0` sur 2700 ticks de banc). La
    // decision de cette entree reposait donc sur un mecanisme qui n'avait
    // JAMAIS fonctionne pour aucune des cinq paires — ni pour celle-ci, ni
    // pour Vaporisation/Paratonnerre dont elle reprenait le raisonnement.
    // `zoneInvolvesVifArgent` (voir son docbloc) lit desormais la PAIRE,
    // pas le nibble d'element : une zone de Gel profond LIE et ELARGIT
    // desormais, comme les quatre autres paires du Vif-argent — AUCUNE
    // exception de jeu n'a ete retrouvee dans la spec qui justifie d'en
    // garder une pour celle-ci specifiquement, mais ce point MERITE une
    // revue de jeu dediee (voir le rapport de la revue post-tache 9) avant
    // de considerer la question definitivement close.
    id: REACTION.GEL_PROFOND,
    name: 'gel-profond',
    pair: packElementPair(ELEMENT.GIVRE, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 0,
    zoneArmorReduction: 0,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.35),
    zoneShape: 'lobes',
  },
  {
    // Mortier vif (Poix + Chaux, tache 6 de l'etape 5c) : « scelles et
    // fragiles » (§5 de la spec) — vitesse NULLE (l'immobilisation, comme la
    // Supraconduction et Gel profond) ET amplification des degats (la
    // fragilite, comme la Poix). DEUX grandeurs PROPRES a la reaction, plus
    // DEUX planchers pour la moitie Chaux du couple.
    //
    // ⚠️ **`zoneSlowFactor: 0` est un effet PROPRE, pas un plancher — ni la
    // Poix ni la Chaux ne portent de `slowFactor` non neutre (voir
    // `ELEMENT_DEFS`), donc rien ne « fuiterait » a travers le minimum si ce
    // champ restait neutre.** Exactement comme Supraconduction et Gel
    // profond, l'immobilisation nait ICI, de la reaction seule.
    //
    // ⚠️ **`zoneDamageAmp` : la PIECE QUI MANQUAIT (verifiee — `grep -c
    // zoneDamageAmp` rendait 0 avant cette tache), et le plancher qui va
    // avec.** Sans ce champ, Mortier vif aurait herite l'amplification de
    // l'element du DECLENCHEUR (Poix, 1,5, OU Chaux, 1, selon l'ordre
    // d'arrivee) — fragile une fois sur deux seulement.
    // `elementOf(ELEMENT.POIX).damageAmp` REUTILISE (jamais recopie), meme
    // discipline que Verglas pour `zoneSlowFactor` : le plancher garantit
    // exactement ce qu'une flaque de Poix SEULE laisserait deja, ni plus ni
    // moins, quel que soit l'ordre. Combine par MAXIMUM avec l'element porte
    // (`zoneDamageAmpTotal`, plus bas) : max(1, 1,5) = 1,5 si Chaux
    // declenche, max(1,5, 1,5) = 1,5 si Poix declenche — la MEME
    // amplification dans les deux cas.
    //
    // ⚠️ **`zoneArmorReduction` ET `zoneFieldSign` sont EXPLICITES, jamais
    // heritees de l'element — le meme piege des DEUX planchers que Fournee,
    // Eclat de gel et Arc caustique avant elle.** Cette paire apparie la
    // Chaux, qui porte DEUX proprietes non neutres (`armorReduction` et
    // `fieldSign: -1`) : sans plancher explicite, la zone corroderait une
    // fois sur deux et fuirait une fois sur deux selon l'ordre d'arrivee.
    // Mortier vif ne PRETEND a aucun des deux effets au §5 de la spec
    // (contrairement a Fournee, qui va jusqu'a `MAX_ARMOR`) : les planchers
    // choisis (`elementOf(ELEMENT.CHAUX).armorReduction`,
    // `elementOf(ELEMENT.CHAUX).fieldSign`) garantissent seulement ce qu'une
    // Chaux SEULE laisserait deja — meme raisonnement qu'Eclat de gel pour
    // son armure.
    //
    // ⚠️ **CORRIGE a la tache 6, tour de correction 1 — une revue a MESURE
    // que la fuite plancheee par `zoneFieldSign` N'EST PAS sans effet,
    // contrairement a ce que ce paragraphe affirmait (« une entite scellee
    // ne fuit jamais »).** C'est vrai PENDANT la vie de la zone, faux
    // APRES. `#advanceByVelocity` (`Horde`, `shared/horde.ts`) module le
    // PAS par `#slow`, jamais la vitesse TENUE (`vx`/`vy`) — celle-ci reste
    // la trajectoire que `#recomputeSteering` calcule, et qui ne tourne
    // qu'une fois tous les `STEERING_RECOMPUTE_TICKS` (9 ticks). Tant que
    // la zone vit, `#slow` a 0 fige bien la POSITION quel que soit le signe
    // de `vx`/`vy` — mais `vx`/`vy`, EUX, continuent d'etre recalcules a
    // chaque recompute avec la direction INVERSEE (`fieldSign: -1`).
    // Quand la zone expire, `#slow` repasse a 1 AVANT que le prochain
    // recompute ne corrige `vx`/`vy` : l'entite avance donc PLEIN POT dans
    // la direction FUYANTE pendant jusqu'a `STEERING_RECOMPUTE_TICKS - 1`
    // ticks (environ 25 px, mesure a la revue) avant de se reorienter vers
    // le joueur. **La horde scellee gicle en arriere quand le sceau meurt.**
    // Le §5 de la spec dit « scelles et fragiles », pas « ejectes » — c'est
    // un ARTEFACT DE JEU NON TRANCHE, documente ici plutot que corrige : le
    // plancher reste neanmoins REQUIS, sans lui ce recul dependrait EN PLUS
    // de l'ordre d'arrivee des deux projectiles, pire qu'un recul
    // systematique. Voir le test « gicle en arriere a l'expiration … » dans
    // `shared/horde.test.ts`, et la reserve correspondante dans le rapport
    // de la tache 6 (question portee a l'auteur, pas tranchee ici).
    id: REACTION.MORTIER_VIF,
    name: 'mortier-vif',
    pair: packElementPair(ELEMENT.POIX, ELEMENT.CHAUX),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: Math.round(ZONE_LIFETIME_TICKS * 0.6),
    radius: 0,
    damage: 0,
    zoneSlowFactor: 0,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneDamageAmp: elementOf(ELEMENT.POIX).damageAmp,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 0.75),
    zoneShape: 'rond',
  },
  {
    // Aveuglement (Chaux + Vif-argent, tache 6 de l'etape 5c) : la fuite,
    // PLUS LONGUE que la Chaux seule (§5 de la spec) — meme raisonnement que
    // Gel profond face a la Supraconduction : `fieldSign` n'a que deux
    // valeurs possibles (+1/-1), rien n'est « plus fort » que -1, donc la
    // DUREE est le seul levier qui separe Aveuglement d'une Chaux seule.
    //
    // ⚠️ **Ecart au §6.4 ASSUME ICI, explicitement — §6.4 dit que ces
    // ennemis « perdent leur cible et errent ».** Le §2 de la spec de
    // l'etape 5c a deja tranche la fuite plutot que l'errance pour la Chaux
    // seule ; Aveuglement REPREND cette decision plutot que d'en inventer
    // une troisieme : une horde qui erre perd sa pression, et la pression
    // est la tension du genre (bullet heaven). Ce n'est pas une seconde
    // decision de jeu — c'est la MEME, heritee du couple qui porte deja la
    // fuite (la Chaux).
    //
    // ⚠️ **`zoneLifetimeTicks` REUTILISE `SURCHAUFFE_ZONE_LIFETIME_TICKS`
    // (135 ticks, 4,5 s), meme reglage que Gel profond ci-dessus et pour la
    // meme raison.** Une Chaux SEULE (sans reaction nommee) vit la duree
    // GENERIQUE (90 ticks, 3 s) — n'importe quelle duree strictement
    // superieure suffirait a satisfaire « plus longue » ; reprendre le
    // multiplicateur deja etabli evite un second chiffre arbitraire.
    //
    // ⚠️ **`zoneArmorReduction` ET `zoneFieldSign` sont EXPLICITES, jamais
    // heritees de l'element — le meme piege des DEUX planchers que Fournee,
    // Eclat de gel, Arc caustique et Mortier vif avant elle.** Vif-argent est
    // NEUTRE sur les cinq grandeurs de cette table (voir son entree dans
    // `ELEMENT_DEFS`) : seule la Chaux porte des grandeurs non neutres ici,
    // et les deux doivent etre plancheees pour ne pas dependre de l'ordre
    // d'arrivee (Chaux OU Vif-argent selon quel projectile touche en
    // second). Les planchers choisis
    // (`elementOf(ELEMENT.CHAUX).armorReduction`,
    // `elementOf(ELEMENT.CHAUX).fieldSign`) garantissent exactement ce
    // qu'une Chaux SEULE laisserait deja — Aveuglement n'AJOUTE aucune
    // reduction d'armure, elle garantit la fuite plus longtemps.
    //
    // ⚠️ **Le pare-feu de la tache 3 est SUPPRIME (revue post-tache 9),
    // meme renversement et meme raisonnement que Gel profond ci-dessus.**
    // Une zone d'Aveuglement LIE et ELARGIT desormais le rayon de touche,
    // comme les quatre autres paires du Vif-argent — voir le docbloc de
    // Gel profond pour le detail complet de ce qui a change et pourquoi.
    id: REACTION.AVEUGLEMENT,
    name: 'aveuglement',
    pair: packElementPair(ELEMENT.CHAUX, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: SURCHAUFFE_ZONE_LIFETIME_TICKS,
    radius: 0,
    damage: 0,
    zoneSlowFactor: 1,
    zoneArmorReduction: elementOf(ELEMENT.CHAUX).armorReduction,
    zoneDamageAmp: 1,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: elementOf(ELEMENT.CHAUX).fieldSign,
    zoneVifArgent: false,
    zoneRadius: Math.round(ZONE_RADIUS * 1.2),
    zoneShape: 'lobes',
  },
  {
    // Amalgame (Poix + Vif-argent, tache 7 de l'etape 5c) : « les degats
    // subis par un ennemi lie frappent aussi ses voisins » (§5 de la spec) —
    // la SEULE reaction structurellement neuve de l'etape, « portee par :
    // serveur seul » (ni zone, ni geometrie, ni `chainTargets`, contrairement
    // aux huit autres). Voir `shareAmalgameDamage` (`back/src/combat.ts`) :
    // `def.damage` frappe l'ennemi qui declenche PUIS, une seule fois chacun
    // et sans recursion, chacun de ses voisins LIES (`linkedNeighbours`,
    // tache 3) — jamais un balayage par rayon (`damageInRadius`) ni une
    // chaine (`chainTargets`), les deux formes deja prises par Vaporisation
    // et Paratonnerre pour ce meme couple d'idees (« liaison + degat »).
    //
    // ⚠️ **`radius: 0`, `damage: REACTION_DAMAGE` — reutilise, pas invente.**
    // Aucune donnee de jeu ne motive un second chiffre : meme decision que
    // Vaporisation, Court-circuit, Arc caustique et Paratonnerre avant elle.
    // `radius` reste a 0 (n/a) : Amalgame ne balaie AUCUN rayon geometrique,
    // au contraire de Vaporisation — `linkedNeighbours` EST toute sa
    // geometrie, elle ne balaie jamais un second cercle par-dessus.
    //
    // ⚠️ **`zoneDamageAmp` : le SEUL plancher que ce couple reclame — verifie
    // par lecture d'`ELEMENT_DEFS`, pas suppose.** Vif-argent est NEUTRE sur
    // les cinq grandeurs combinantes de cette table (voir son entree dans
    // `shared/elements.ts`) ; la Poix ne porte qu'UNE grandeur non neutre,
    // `damageAmp` (1,5) — ni brulure, ni ralentissement, ni reduction
    // d'armure, ni fuite. Sans ce plancher, une zone d'Amalgame amplifierait
    // les degats de qui s'y tient seulement si la Poix est arrivee EN SECOND
    // (le nibble d'element porte alors Poix, 1,5) et pas si le Vif-argent est
    // arrive en second (le nibble porte alors Vif-argent, neutre, 1) — le
    // meme piege d'ordre que `zoneArmorReductionTotal`/`zoneFieldSign`
    // documentent deja pour la Chaux, ici pour la Poix. `elementOf(ELEMENT.POIX
    // ).damageAmp` REUTILISE (jamais recopie), meme discipline que Verglas et
    // Mortier vif : le plancher garantit exactement ce qu'une flaque de Poix
    // SEULE laisserait deja, ni plus ni moins, quel que soit l'ordre.
    // `zoneDamageAmpTotal` la combine par MAXIMUM avec l'element porte, jamais
    // une somme : max(1, 1,5) = 1,5 si Vif-argent declenche, max(1,5, 1,5) =
    // 1,5 si Poix declenche — la MEME amplification dans les deux cas. Voir
    // le test « le plancher de zoneDamageAmp d'Amalgame reste un PLAFOND … »,
    // `shared/reactions.test.ts`.
    //
    // ⚠️ **Aucun autre plancher requis.** `zoneArmorReduction` et
    // `zoneFieldSign` restent neutres : ni la Poix ni le Vif-argent ne
    // portent d'armure ni de fuite (contrairement a tout couple qui apparie
    // la Chaux). `zoneSlowFactor` reste neutre (1) pour la meme raison :
    // aucun des deux elements de ce couple ne ralentit. `zoneBurnPerTick`
    // reste a zero, et n'aurait de toute facon rien a fuiter meme si la
    // Braise avait ete de la partie (ce champ ne combine JAMAIS avec
    // l'element, voir son docbloc plus haut).
    id: REACTION.AMALGAME,
    name: 'amalgame',
    pair: packElementPair(ELEMENT.POIX, ELEMENT.VIF_ARGENT),
    zoneBurnPerTick: 0,
    zoneLifetimeTicks: 0,
    radius: 0,
    damage: REACTION_DAMAGE,
    zoneSlowFactor: 1,
    zoneArmorReduction: 0,
    zoneDamageAmp: elementOf(ELEMENT.POIX).damageAmp,
    zoneInertiaDamping: 1,
    zoneCollisionDamage: 0,
    zoneFieldSign: 1,
    zoneVifArgent: true,
    zoneRadius: Math.round(ZONE_RADIUS * 0.9),
    zoneShape: 'rond',
  },
];

/** La reaction specifique du couple `pair`, ou `undefined` : le Choc thermique generique s'applique alors. */
export function reactionForPair(pair: number): ReactionDef | undefined {
  return REACTION_DEFS.find((r) => r.pair === pair);
}

/** La reaction portant l'identifiant `id` (le nibble de reaction d'un `ZoneField.kind`), ou `undefined`. */
export function reactionOfId(id: number): ReactionDef | undefined {
  return REACTION_DEFS.find((r) => r.id === id);
}

/**
 * Vrai si la zone laissee par cette reaction COMPTE COMME DU VIF-ARGENT —
 * lit `ReactionDef.zoneVifArgent` (voir son docbloc pour l'historique
 * complet en trois temps). UN SEUL critere pour DEUX consommateurs :
 * `linkedNeighbours` (`shared/links.ts`, §3 de la spec, la liaison) ET
 * `ZoneField.hitRadiusBonusAt` (`shared/zones.ts`, §4, le rayon de touche
 * elargi) lisent cette MEME fonction — il n'existe plus deux predicats a
 * tenir synchrones.
 *
 * ⚠️ **Troisieme forme de ce correctif, et DERNIERE connue.** Un dériveur
 * sur la paire (retire) faisait les deux effets pour les CINQ paires du
 * Vif-argent, y compris Gel profond et Aveuglement — dont l'entree de cette
 * table (tache 6) decide l'inverse en citant le §5 de la spec (« vitesse
 * nulle » / « la fuite », jamais la liaison ni le rayon). Un champ epingle
 * mais consulte par UN SEUL des deux consommateurs (`zoneLinks`, renomme)
 * laissait l'AUTRE consommateur sur l'ancien dériveur — Gel profond
 * elargissait le rayon de touche sans plus lier, une divergence que
 * personne n'avait choisie. Un seul champ, lu par les deux, ferme le cas :
 * `true` sur Vaporisation, Paratonnerre et Amalgame SEULEMENT — les trois
 * qui ont BESOIN du Vif-argent pour leur propre effet — `false` partout
 * ailleurs, y compris sur Gel profond et Aveuglement, pour LES DEUX usages.
 *
 * ⚠️ **ORDRE-INDEPENDANT PAR CONSTRUCTION — un CHAMP de la ligne de
 * `REACTION_DEFS`, lue par `id` (`zoneReaction(kind)`), jamais par
 * l'element.** Cette valeur ne depend d'AUCUN element, donc d'aucun ordre
 * d'arrivee des deux projectiles — le probleme d'ordre que l'ancien filtre
 * visait a resoudre (le nibble d'element porte le DECLENCHEUR, Vif-argent
 * OU son partenaire selon l'ordre) ne se pose plus du tout ici.
 *
 * ⚠️ **Le cas `zoneReaction(kind) === 0` reste gere a part** : une zone SANS
 * reaction n'a pas de ligne a lire dans `REACTION_DEFS`
 * (`reactionOfId(0)` ne trouve rien, `0` n'etant l'identifiant d'aucune
 * entree) — il n'y a alors qu'un seul element, pas un couple, donc
 * `zoneElement(kind) === ELEMENT.VIF_ARGENT` reste le bon repli pour ce cas
 * (fictif en production — `postZone`, `back/src/combat.ts`, le SEUL
 * createur de zones, ne pose jamais de zone a reaction nulle qui porte le
 * Vif-argent — mais que l'API de `ZoneField` n'interdit pas et que les
 * tests utilisent comme raccourci).
 */
export function zoneVifArgent(kind: number): boolean {
  const reactionId = zoneReaction(kind);
  if (reactionId === 0) {
    return zoneElement(kind) === ELEMENT.VIF_ARGENT;
  }
  return reactionOfId(reactionId)?.zoneVifArgent ?? false;
}

/**
 * La duree de vie qu'une zone doit tenir, DERIVEE de son `kind` empaquete —
 * `ZONE_LIFETIME_TICKS` par defaut, la duree propre a sa reaction si elle en
 * porte une (Surchauffe aujourd'hui).
 *
 * ⚠️ **Lue des DEUX cotes du fil**, par `ZoneField.aliveAt`/`expire`
 * (`shared/zones.ts`) : le client et le serveur decodent le meme octet et
 * obtiennent la meme reponse, sans rien annoncer de plus.
 */
export function zoneLifetimeTicks(kind: number): number {
  const def = reactionOfId(zoneReaction(kind));
  return def && def.zoneLifetimeTicks > 0 ? def.zoneLifetimeTicks : ZONE_LIFETIME_TICKS;
}

/**
 * Le rayon qu'une zone doit couvrir, DERIVE de son `kind` empaquete —
 * `ZONE_RADIUS` par defaut, le rayon propre a sa reaction si elle en porte un
 * (etape 8).
 *
 * ⚠️ **Lu des DEUX cotes du fil**, exactement comme `zoneLifetimeTicks` : par
 * `ZoneField` pour decider qui est dedans, par `ZoneRenderer` pour decider ce
 * qu'il dessine. Le client et le serveur decodent le meme octet et obtiennent
 * la meme reponse, sans rien annoncer de plus — c'est ce qui permet de faire
 * varier la taille des champs sans toucher au protocole.
 */
export function zoneRadius(kind: number): number {
  const def = reactionOfId(zoneReaction(kind));
  return def && def.zoneRadius > 0 ? def.zoneRadius : ZONE_RADIUS;
}

/**
 * La silhouette d'une zone, DERIVEE de son `kind` — `'rond'` pour une zone
 * sans reaction, celle de sa reaction sinon.
 */
export function zoneShape(kind: number): ZoneShape {
  return reactionOfId(zoneReaction(kind))?.zoneShape ?? 'rond';
}

/** Le degat par tick qu'une zone inflige d'elle-meme, derive de son `kind` empaquete (0 : elle ne brule pas). */
export function zoneBurnPerTick(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneBurnPerTick ?? 0;
}

/**
 * Le facteur de vitesse qu'une zone impose, DERIVE de son `kind` empaquete —
 * lu par `Horde#computeSlow` (`shared/horde.ts`), qui VOYAGE des deux cotes
 * du fil.
 *
 * ⚠️ **Le MINIMUM de l'element porte ET de la reaction, jamais l'un seul.**
 * Le nibble d'element d'une zone de reaction porte celui du DECLENCHEUR
 * (`ReactionTrigger.element`), qui varie selon l'ordre d'arrivee des deux
 * elements. Pour la Supraconduction (Givre + Foudre), le nibble d'element
 * porte Givre OU Foudre selon cet ordre — `elementOf(zoneElement(kind)).slowFactor`
 * seul rendrait donc 0,6 (Givre) ou 1 (Foudre), jamais le gel total que la
 * reaction impose. Combiner par minimum avec `ReactionDef.zoneSlowFactor`
 * (0 pour la Supraconduction) rend le resultat INDEPENDANT de cet ordre :
 * `min(0,6, 0)` et `min(1, 0)` valent tous deux 0.
 *
 * ⚠️ **Meme raison arithmetique que le minimum de `Horde#computeSlow`, pas
 * une decision de jeu** — voir son docbloc : cette grandeur voyage, et
 * l'ordre d'iteration des zones n'est pas garanti identique des deux cotes du
 * fil, donc seule une combinaison exactement commutative et associative
 * survit.
 *
 * ⚠️ **Le piege que la revue de la tache 7 a vu venir pour Verglas (tache 8),
 * et qui NE se serait PAS resolu de lui-meme.** Pour la Supraconduction,
 * `reactionFactor = 0` est un PLANCHER ABSOLU : `min(x, 0) = 0` quel que
 * soit `x`. Verglas n'a pas ce luxe — si sa ligne avait laisse
 * `zoneSlowFactor: 1` (neutre, comme les trois reactions de la tache 6),
 * `min(elementFactor, 1) = elementFactor` aurait rendu 0,6 (Givre declenche)
 * OU 1 (Poix declenche), et la meme Verglas aurait glisse ou pas selon quel
 * projectile a touche en second. Sa ligne porte donc un facteur EXPLICITE
 * (`elementOf(ELEMENT.GIVRE).slowFactor`, pas une reference neutre), choisi
 * pour etre un plancher aussi — voir le commentaire de son entree dans
 * `REACTION_DEFS`.
 */
export function zoneSlowFactor(kind: number): number {
  const elementFactor = elementOf(zoneElement(kind)).slowFactor;
  const reactionFactor = reactionOfId(zoneReaction(kind))?.zoneSlowFactor ?? 1;
  return Math.min(elementFactor, reactionFactor);
}

/**
 * La MOITIE reaction de la reduction d'armure d'une zone, DERIVEE de son
 * `kind` empaquete (0 : aucun effet) — la Supraconduction (tache 7 de
 * l'etape 5b) est la seule reaction a en porter une aujourd'hui.
 *
 * ⚠️ **N'est plus la grandeur COMPLETE depuis la tache 1 de l'etape 5c.**
 * `Element` porte desormais aussi un `armorReduction` (la Chaux) : c'est
 * `zoneArmorReductionTotal`, juste en dessous, qui combine les deux, exactement
 * comme `zoneSlowFactor` combine `Element.slowFactor` et
 * `ReactionDef.zoneSlowFactor`. Cette fonction-ci reste la lecture NUE de la
 * table des reactions, inchangee depuis la tache 7 — `ZoneField.armorReductionAt`
 * lit desormais `zoneArmorReductionTotal`, jamais celle-ci directement.
 */
export function zoneArmorReduction(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneArmorReduction ?? 0;
}

/**
 * La reduction d'armure qu'une zone impose, ELEMENT et REACTION confondus —
 * lue par `ZoneField.armorReductionAt` (`shared/zones.ts`), qui ne voyage
 * jamais (voir `armureA`, `back/src/combat.ts`).
 *
 * ⚠️ **Meme raison d'etre que `zoneSlowFactor`** : le nibble d'element d'une
 * zone de reaction porte celui du DECLENCHEUR, qui varie selon l'ordre
 * d'arrivee. Deriver de l'element seul rendrait l'effet dependant de cet
 * ordre — le bug que l'etape 5b a paye deux fois (voir le docbloc du
 * module).
 *
 * ⚠️ **Un MAXIMUM entre les deux contributions, jamais une somme — decision
 * de jeu, pas contrainte arithmetique.** Deux sources de corrosion ne
 * s'additionnent pas, comme deux flaques de Poix n'additionnent pas leur
 * amplification (`ZoneField.ampAt`) : c'est la MEME raison que le maximum
 * d'`ampAt`/`armorReductionAt`/`collisionDamageAt`/`burnAt`, PAS celle,
 * arithmetique, du minimum de `Horde#computeSlow` (ou de `zoneSlowFactor`
 * ci-dessus, qui partage sa raison). Ne pas confondre les deux dans un futur
 * commentaire : voir le docbloc de `ZoneField.ampAt` pour la distinction
 * complete.
 */
export function zoneArmorReductionTotal(kind: number): number {
  const elementReduction = elementOf(zoneElement(kind)).armorReduction;
  const reactionReduction = zoneArmorReduction(kind);
  return Math.max(elementReduction, reactionReduction);
}

/**
 * L'amplification des degats qu'une zone impose, ELEMENT et REACTION
 * confondus — lue par `ZoneField.ampAt` (`shared/zones.ts`), qui ne voyage
 * jamais (le client ne prononce aucun degat, §2 de la spec de l'etape 5c).
 *
 * ⚠️ **Meme raison d'etre que `zoneArmorReductionTotal` juste au-dessus** :
 * le nibble d'element d'une zone de reaction porte celui du DECLENCHEUR, qui
 * varie selon l'ordre d'arrivee. Deriver de l'element seul (Mortier vif,
 * Poix + Chaux) rendrait l'amplification dependante de cet ordre — fragile
 * une fois sur deux, solide l'autre.
 *
 * ⚠️ **Un MAXIMUM entre les deux contributions, jamais une somme ni un
 * produit — decision de JEU, pas contrainte arithmetique, EXACTEMENT la
 * meme forme que `zoneArmorReductionTotal` et le maximum que `ZoneField.ampAt`
 * applique deja entre deux zones qui se recouvrent (tache 4 de l'etape 5b).**
 * Deux sources d'amplification ne s'additionnent pas : une flaque de Poix et
 * une zone de Mortier vif qui se recouvrent donnent la plus forte des deux,
 * jamais leur somme (3) ni leur produit (2,25).
 */
export function zoneDamageAmpTotal(kind: number): number {
  const elementFactor = elementOf(zoneElement(kind)).damageAmp;
  const reactionFactor = reactionOfId(zoneReaction(kind))?.zoneDamageAmp ?? 1;
  return Math.max(elementFactor, reactionFactor);
}

/**
 * Le facteur de conservation de vitesse qu'une zone impose, DERIVE de son
 * `kind` empaquete (1 : aucun effet) — lu par `Horde#recomputeSteering`
 * (`shared/horde.ts`), qui VOYAGE des deux cotes du fil.
 *
 * ⚠️ **Aucune combinaison avec l'element du nibble ici, contrairement a
 * `zoneSlowFactor`.** `Element` ne porte aucune notion de friction ou
 * d'inertie : seule la reaction en decide, et Verglas (tache 8 de l'etape
 * 5b) est aujourd'hui la seule a en porter une.
 */
export function zoneInertiaDamping(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneInertiaDamping ?? 1;
}

/**
 * Le degat par tick entre deux ennemis qui se percutent dans une zone,
 * DERIVE de son `kind` empaquete (0 : aucun effet) — lu par
 * `resolveVerglasCollisions` (`back/src/combat.ts`), qui ne voyage JAMAIS
 * (un degat, comme `zoneArmorReduction` : seul le serveur le lit).
 */
export function zoneCollisionDamage(kind: number): number {
  return reactionOfId(zoneReaction(kind))?.zoneCollisionDamage ?? 0;
}

/**
 * Le signe qu'une zone impose a la direction du champ de deplacement,
 * ELEMENT et REACTION confondus : `-1` la zone inverse la direction (fuite),
 * `+1` elle ne la touche pas. Lu par `Horde` (etape 5c, tache 1), qui VOYAGE
 * des deux cotes du fil — meme raisonnement que `zoneSlowFactor`, dont cette
 * fonction reprend exactement la forme.
 *
 * ⚠️ **Meme piege d'ordre que `zoneArmorReductionTotal` et `zoneSlowFactor`,
 * et le MEME remede : le MINIMUM entre les deux contributions.** Le nibble
 * d'element d'une zone de reaction porte celui du DECLENCHEUR, qui varie
 * selon l'ordre d'arrivee — deriver de l'element seul rendrait la fuite
 * dependante de cet ordre. Le minimum sur le domaine `{+1, -1}` implemente
 * une regle "OR" : `-1` (fuite) l'emporte des qu'UNE des deux contributions
 * l'impose, exactement comme `reactionFactor = 0` emporte tout sur
 * `zoneSlowFactor`.
 *
 * ⚠️ **CORRIGE a la tache 6 de l'etape 5c — ce docbloc affirmait encore
 * qu'aucune ligne ne surchargeait `zoneFieldSign`, une revue l'a signale
 * perime.** `Element.fieldSign` (la Chaux) reste la SEULE source non
 * neutre, mais CINQ lignes de `REACTION_DEFS` portent desormais un
 * `zoneFieldSign: -1` EXPLICITE — les cinq couples reels de la Chaux :
 * Fournee et Eclat de gel (tache 4), Arc caustique (tache 5), Mortier vif
 * et Aveuglement (tache 6, qui clot la liste que cette phrase enumerait).
 * Une zone de Chaux SANS reaction nommee (le Choc thermique generique —
 * toujours possible, la table `REACTION_DEFS` ne couvre pas tous les
 * couples) reste le seul cas ou `zoneFieldSign` derive de l'element SEUL ;
 * pour les cinq couples ci-dessus, le plancher rend le resultat
 * INDEPENDANT de l'ordre d'arrivee, comme `zoneArmorReductionTotal` l'est
 * deja pour eux. Voir `shared/reactions.test.ts` : le test qui exerce
 * encore l'etat ORDRE-DEPENDANT le fait desormais sur un couple FICTIF
 * (aucun couple reel n'y est plus exposable) — il garde le MECANISME, pas
 * un etat de production.
 */
export function zoneFieldSign(kind: number): number {
  const elementSign = elementOf(zoneElement(kind)).fieldSign;
  const reactionSign = reactionOfId(zoneReaction(kind))?.zoneFieldSign ?? 1;
  return Math.min(elementSign, reactionSign);
}
