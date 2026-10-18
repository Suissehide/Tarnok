/**
 * Les armes, pilotees par la donnee, comme `shared/archetypes.ts` : un
 * systeme unique lit cette table, et ajouter une arme est du contenu, pas de
 * l'architecture.
 *
 * ⚠️ **Une arme ne monte PAS de niveau.** Elle s'EMPILE, exactement comme un
 * passif : chaque carte prise ajoute un exemplaire, et c'est l'accumulation
 * qui fait la puissance.
 */

import { PLAYER_SPEED, TICK_HZ, ZONE_RADIUS } from './constants';
import { ELEMENT, elementOf } from './elements';

/**
 * Les formes de projectile connues.
 *
 * ⚠️ **Un NOM, jamais un dessin.** Le dessin vit cote client
 * (`front/src/render/projectile-renderer.ts`, qui en cuit un atlas au
 * chargement) ; `shared/` n'a ni canevas ni `document`. C'est exactement le
 * rapport que `Weapon.element` entretient avec `ELEMENTS` : une reference dans
 * la donnee, resolue ailleurs.
 *
 * **Ajouter une arme reste du contenu** : elle choisit une forme existante,
 * comme elle choisit un element existant. Ajouter une forme, en revanche, est
 * un dessin de plus cote client — et `projectile-renderer.test.ts` verifie que
 * chaque forme du catalogue en a un.
 */
export type ProjectileShape =
  | 'lame'
  | 'fleche'
  | 'petale'
  | 'flamme'
  | 'sphere'
  | 'anneau'
  | 'aiguille'
  | 'grain'
  | 'eclat'
  | 'arc'
  | 'javelot'
  | 'goutte'
  | 'masse'
  | 'bouffee'
  | 'obus'
  | 'dard'
  | 'glaive';

/**
 * Les profils de trainee.
 *
 * ⚠️ **Un profil, pas une longueur.** La LONGUEUR reste derivee de
 * `look.trailTicks` et de la vitesse (`projectileTrailPx`) ; ce champ ne dit
 * que la MATIERE de la trace, c'est-a-dire le degrade cuit dans la case
 * d'atlas que le quad porte. Les deux sont independants : une trainee courte
 * peut fumer, une longue peut crepiter.
 *
 * ⚠️ **Quatre profils, et le quad reste UN.** La trainee est toujours un seul
 * quad etire dans l'axe du vol (voir `ProjectileRenderer`) : l'atlas change
 * ce qu'on voit dedans, jamais combien il en faut. C'est ce qui permet de
 * donner une matiere par arme sans toucher la borne de deux quads par
 * projectile, mesuree par `projectile-renderer.test.ts`.
 *
 * | Profil | Ce qu'on voit | Pour |
 * | --- | --- | --- |
 * | `lisse` | un trait qui s'effile, bords adoucis | ce qui file : lames, fleches, aiguilles |
 * | `fumee` | des bouffees qui grossissent vers l'arriere | ce qui brule ou englue |
 * | `tirets` | une file de segments detaches | ce qui est jete par poignees |
 * | `etincelles` | un trait crible de points chauds | ce qui crepite |
 */
export type ProjectileTrail = 'lisse' | 'fumee' | 'tirets' | 'etincelles';

/**
 * L'apparence du projectile d'une arme.
 *
 * ⚠️ **La teinte n'est PAS celle de l'element, et `assertWeaponLooks` le
 * refuse.** Une arme neutre doit rester reconnaissable, et deux armes du meme
 * element doivent se distinguer l'une de l'autre : l'element se lit a la zone
 * qu'elle laisse au sol (`ZoneRenderer`) et a la marque sur l'ennemi, pas au
 * point lumineux qui vole. Chaque arme, sa teinte de projectile propre.
 *
 * ⚠️ **Aucune atténuation ici.** Le fondu de fin de vie se DERIVE de
 * `projectileLifeTicks` (voir `projectileAlpha`) : un second champ le
 * decrirait une deuxieme fois, et les deux finiraient par se contredire.
 */
export interface ProjectileLook {
  shape: ProjectileShape;
  /**
   * Empreinte dessinee, halo compris, en pixels monde. Le corps plein en
   * occupe une fraction fixe (voir `PROJECTILE_SHAPE_FRACTION` cote client) :
   * deux armes de meme `diameterPx` occupent donc la meme place a l'ecran quel
   * que soit leur `glow`.
   *
   * ⚠️ **Assez grand pour se lire** : une case d'atlas dessine la silhouette
   * sur 32 px, et a 5 ou 10 px a l'ecran il ne reste rien de ce que la forme
   * dit.
   *
   * ⚠️ **LA TAILLE DIT CE QUE LE COUP PESE** : les calibres suivent l'ordre
   * des `damage`, departage par la cadence, et restent distincts deux a deux.
   * `weapons.test.ts` garde l'ordre : une arme ajoutee doit choisir un
   * calibre coherent avec ses degats.
   *
   * ⚠️ **Purement COSMETIQUE, et surtout pas `blastRadius`.** Ce qui meurt ne
   * bouge pas d'un pixel ; `weapons.test.ts` garde que les deux ne se
   * confondent jamais.
   */
  diameterPx: number;
  /** Teinte du projectile, 0xRRGGBB. Voir l'avertissement ci-dessus. */
  tint: number;
  /** Intensite du halo, de 0 (aucun) a 1 (aussi opaque que le corps). */
  glow: number;
  /**
   * Tours par seconde que la tete fait sur elle-meme en vol, signe.
   * `0` : elle pointe droit dans l'axe du vol et ne tourne jamais.
   *
   * ⚠️ **En tours par SECONDE, et jamais en radians par image.** Le rendu la
   * convertit avec l'AGE EN TICKS du projectile (`ticksRemaining`, que la
   * simulation tient deja) : la rotation est donc la meme a 30 et a 144 images
   * par seconde, et elle ne demande aucune horloge de plus a
   * `ProjectileRenderer.draw`. Meme discipline que `trailTicks`, qui se compte
   * en ticks de vol et pas en pixels.
   *
   * ⚠️ **Zero n'est pas l'absence de reglage, c'est un reglage.** Une fleche,
   * une aiguille et une lame DOIVENT rester dans l'axe : les faire tourner
   * effacerait justement ce que leur silhouette dit (elles percent). Ce qui
   * tourne, c'est ce qui est lance : un chakram, un glaive, une grenade, de la
   * mitraille.
   */
  spinTurns: number;
  /** La matiere de la trainee — voir `ProjectileTrail`. */
  trail: ProjectileTrail;
  /**
   * Longueur de la trainee, exprimee en **ticks de vol**.
   *
   * ⚠️ **En ticks, pas en pixels** : la trainee dessine la distance que le
   * projectile vient REELLEMENT de parcourir (`projectileTrailPx`). Une
   * longueur en pixels reglee a cote de `projectileSpeed` mentirait des la
   * premiere retouche de vitesse — meme discipline que `spriteScale` et
   * `zoneScale`, ou la taille dessinee est derivee de la portee reelle.
   */
  trailTicks: number;
}

/**
 * La FAMILLE d'une arme.
 *
 * ⚠️ **Un discriminant, et le MINIMUM de valeurs possible.** `'tir'` couvre
 * tout ce qui pose des projectiles, anneau compris : un tir circulaire n'est
 * pas une famille, c'est une `spreadRadians` qui fait un tour, ou une
 * `emission` en spirale. Une valeur n'entre ici que quand la donnee
 * existante ne peut VRAIMENT pas la dire (le halo : il ne part rien).
 *
 * `'onde'` (un anneau qui s'agrandit depuis le tireur, chaque ennemi frappe
 * une fois) et `'frappe'` (des impacts differes autour du point vise) ne
 * posent aucun projectile ; leur logique pure vit dans
 * `shared/onde-frappe.ts`.
 *
 * ⚠️ **Le branchement vit a UN SEUL endroit par cote** : `Room#fireOne`
 * (serveur) et son miroir cosmetique dans `GameClient`. Une famille de plus y
 * ajoute une branche, nulle part ailleurs.
 */
export type WeaponKind = 'tir' | 'halo' | 'faisceau' | 'invocation' | 'onde' | 'frappe';

export interface Weapon {
  id: number;
  name: string;
  /** La famille de l'arme — voir `WeaponKind`. `'tir'` par defaut. */
  kind: WeaponKind;
  /**
   * Cadence de tir, en ticks.
   *
   * ⚠️ **C'est une donnee de la table, arme par arme — jamais un facteur
   * global** : la cadence est l'un des rares axes qui distinguent les armes
   * entre elles. Voir l'en-tete de `WEAPON_DEFS`.
   */
  cooldownTicks: number;
  /** Degats par projectile. */
  damage: number;
  /** Vitesse du projectile, en pixels monde par seconde. */
  projectileSpeed: number;
  /** Portee, exprimee en duree de vie du projectile, en ticks. */
  projectileLifeTicks: number;
  /** Nombre de projectiles par salve. */
  projectileCount: number;
  /**
   * Largeur angulaire totale de la salve, en radians, repartie
   * symetriquement de part et d'autre de la direction visee.
   *
   * Sans effet quand `projectileCount` vaut 1 : un seul projectile part droit
   * sur la cible, la valeur reste renseignee pour que tous les champs soient
   * strictement positifs quelle que soit l'arme (voir le test).
   */
  spreadRadians: number;
  /**
   * Element porte par les projectiles de cette arme, index dans `ELEMENTS`
   * (`shared/elements.ts`). `ELEMENT.NEUTRE` : l'arme ne marque rien et ne
   * pose aucune zone.
   *
   * ⚠️ Ce champ DOIT designer un element existant : une reference morte ne se
   * verrait qu'au premier tir de cette arme.
   * `assertWeaponElements` ci-dessous verifie chaque reference au CHARGEMENT
   * du module plutot que d'attendre le tir.
   */
  element: number;
  /**
   * Rayon de l'explosion a l'impact, en pixels monde. `0` : le projectile ne
   * touche que ce qu'il percute.
   *
   * ⚠️ **Zero n'est pas un cas particulier, c'est une entree de la table**,
   * comme `ELEMENT.NEUTRE` : c'est la ligne ABSENTE qui est le cas courant. Un
   * booleen « arme de zone » plus un rayon a cote se contrediraient.
   *
   * ⚠️ **Recopie sur le projectile a l'emission** (`Projectiles`), jamais relu
   * dans le catalogue a l'impact — exactement comme `damage`, `element` et
   * `by` : le tir ne depend d'aucune table une fois parti.
   *
   * ⚠️ **Le rayon est SANS RAPPORT avec `look.diameterPx`.** Le premier decide
   * de ce qui meurt, le second de ce qui se dessine ; les confondre ferait
   * regler l'equilibrage a l'oeil, et le dessin par le banc.
   */
  blastRadius: number;
  /**
   * L'apparence de ses projectiles — voir `ProjectileLook`.
   *
   * ⚠️ Champ OBLIGATOIRE, contrairement a `element` : une arme sans apparence
   * retomberait sur celle d'une autre sans que rien ne le dise.
   */
  look: ProjectileLook;
  /**
   * Nombre d'ennemis SUPPLEMENTAIRES qu'un projectile traverse avant d'etre
   * consomme. `0` : il meurt sur le premier qu'il touche.
   *
   * ⚠️ **Zero n'est pas un cas particulier, c'est une entree de la table**,
   * exactement comme `blastRadius` : la ligne ABSENTE est le cas courant, et
   * l'exception se lit d'un coup d'oeil.
   *
   * ⚠️ **Ce n'est pas un rabais sur les degats.** Un projectile transpercant
   * inflige ses degats PLEINS a chacun — c'est ce qui donne a une arme lente
   * une raison d'etre lente. Le prix est ailleurs : il faut aligner les
   * cibles.
   *
   * ⚠️ **Recopie sur le projectile a l'emission**, jamais relu dans le
   * catalogue a l'impact — meme discipline que `damage`, `element` et
   * `blastRadius`.
   */
  pierce: number;
  /**
   * Les bonus PROPRES a cette arme (`UPGRADE`, hors degats et cadence) que ses
   * cartes peuvent porter. Le premier est celui d'une carte sans aspect.
   *
   * ⚠️ **Seulement ce que l'arme sait faire** : une perforation sur un halo ou
   * une salve sur une invocation seraient des cartes vides.
   */
  perks: readonly number[];
  /** Echelle des projectiles, dessin et rayon de touche — `1` au catalogue, grandit avec le calibre. */
  projectileScale: number;
  /**
   * Fraction des degats d'un impact rendue ensuite en poison — `0` au
   * catalogue, grandit avec le venin. Voir `Venins` (`back/src/combat.ts`).
   */
  venom: number;
  /**
   * Rebonds : apres un impact, le projectile repart vers l'ennemi le plus
   * proche (`RICOCHET_RANGE`) au lieu d'etre consomme. `0` : aucun.
   *
   * ⚠️ **Ce n'est pas `pierce`** : la perforation continue TOUT DROIT, le
   * ricochet CHANGE de cap. Une arme qui a les deux perfore d'abord.
   */
  bounces: number;
  /**
   * Guidage, en radians par seconde : de combien le projectile peut tourner
   * vers l'ennemi le plus proche (`HOMING_RANGE`). `0` : il file droit.
   *
   * ⚠️ **La seule trajectoire qui lit la horde.** Serveur et client la
   * calculent chacun sur leur horde — la meme, a la replication pres — donc le
   * missile dessine suit celui qui frappe ; les degats restent au serveur.
   */
  homing: number;
  /**
   * Comment le projectile se deplace — `'droit'` par defaut.
   * Voir `MOTION` ; recopie sur le projectile a l'emission en code numerique.
   *
   * ⚠️ **Optionnel sur le type, et pas seulement dans `WEAPON_DEFS`** : les
   * armes de test ecrites en entier (`projectiles.test.ts`, `combat.test.ts`)
   * restent valides sans y toucher. `Projectiles` lit `?? 'droit'`.
   */
  motion?: Motion;
  /** D'ou part l'angle de la salve — `'visee'` par defaut, voir `SPIRAL_RAD_PER_TICK`. */
  emission?: 'visee' | 'spirale';
  /** Eclats projetes en couronne quand le projectile est consomme — `0` par defaut. */
  fragments?: number;
  /** Croissance de l'echelle (`projectileScale`) par seconde de vol — `0` par defaut. */
  growth?: number;
}

/**
 * L'index dans le tableau **est** l'identifiant, comme pour `ARCHETYPES` :
 * aucune table de correspondance a synchroniser entre serveur et clients.
 *
 * La premiere entree est l'arme neutre de base : faible, sans element, hors
 * slots — celle avec laquelle une run commence toujours.
 *
 * `element` et `blastRadius` sont optionnels : omettre le premier vaut
 * `ELEMENT.NEUTRE`, omettre le second vaut `0` (« ce projectile ne touche que
 * ce qu'il percute »). Quelques armes restent neutres : un socle pour les
 * joueurs qui ne veulent pas jouer le systeme d'elements.
 *
 * **LES CADENCES.** Mesure au banc `kills` : la cadence n'est PAS lineaire et
 * sature bien avant d'etre gratuite (huit fois plus de tirs ne rendent qu'un
 * quart de morts en plus). Le facteur limitant est la VISEE : un second tir
 * parti au meme instant vers le meme point traverse la zone que le premier
 * vient de vider.
 *
 * ⚠️ **Les deux armes les plus rapides sont bornees a la main.** En dessous
 * de 4 ticks, `cooldownWithBonus` ecrase le passif « cadence » : a 4 il garde
 * huit cartes utiles, a 2 il meurt a la quatrieme. La dague est a 4, le
 * lance-flammes a 3, et un test interdit que la dague devienne la plus
 * rapide.
 *
 * ⚠️ **Les cadences restent distinctes, et leur ordre porte la nature des
 * armes** : la plus rapide est le lance-flammes, la plus lente la grenade.
 */
/**
 * Rayon du souffle des armes LOURDES — la moitie de celui de la grenade.
 *
 * ⚠️ **Derive de `ZONE_RADIUS`, comme celui de la grenade, et moitie moins.**
 * La grenade reste l'arme de zone : son souffle couvre exactement le champ
 * qu'une reaction laisse au sol. Un souffle de contact touche le voisin
 * immediat, il ne nettoie pas un groupe. Il compense les lourdes a projectile
 * unique, dont la seule autre contrepartie (la marque) ne rend que si un
 * ALLIE vient la faire reagir.
 *
 * ⚠️ **Le souffle appartient aux armes LENTES a projectile unique**, et
 * `weapons.test.ts` le garde par une propriete : une arme rapide a souffle
 * poserait des explosions en continu. La frappe l'utilise aussi pour chaque
 * impact (`blastRadius`, hors famille `'tir'`).
 */
export const HEAVY_BLAST_RADIUS = ZONE_RADIUS / 2;

/**
 * Ce qu'une carte d'arme ameliore quand on possede DEJA l'arme — un seul
 * aspect par carte.
 *
 * `DAMAGE` et `FIRE_RATE` valent pour toute arme ; les autres sont des BONUS
 * PROPRES, que chaque arme liste dans `Weapon.perks` — seuls ceux-la peuvent
 * sortir sur ses cartes. L'index EST l'identifiant, et c'est l'octet du fil.
 */
export const UPGRADE = {
  /** Salve plus large — `salvoCount`. */
  SALVO: 0,
  DAMAGE: 1,
  FIRE_RATE: 2,
  /** Rayon : explosion d'un tir, cercle d'un halo ou d'une invocation, largeur d'un faisceau — `effectRadius`. */
  ZONE: 3,
  /** Un ennemi de plus traverse — `Weapon.pierce`. */
  PIERCE: 4,
  /** Duree de vie : la portee d'un tir ou d'un faisceau, la duree d'une mine ou d'une invocation. */
  RANGE: 5,
  /** Des projectiles plus GROS : dessin et rayon de touche — `Weapon.projectileScale`. */
  CALIBRE: 6,
  /** Des projectiles plus rapides — donc qui portent plus loin dans la meme duree. */
  VELOCITY: 7,
  /** Une arme sans souffle explose a l'impact — `Weapon.blastRadius` part de zero. */
  DETONATION: 8,
  /** Une part de chaque impact revient en poison sur la duree — `Weapon.venom`. */
  VENOM: 9,
  /** Un rebond de plus vers l'ennemi voisin — `Weapon.bounces`. */
  RICOCHET: 10,
  /** Le projectile se guide vers l'ennemi le plus proche — `Weapon.homing`. */
  HOMING: 11,
} as const;
export const UPGRADE_KINDS = 12;

/** Degats gagnes par carte « degats », en fraction des degats de base. */
export const DAMAGE_PER_UPGRADE = 0.25;
/**
 * Recharge retiree par carte « cadence », en fraction — s'additionne aux
 * passifs de cadence sous le meme plafond `MAX_FIRE_RATE_BONUS`.
 */
export const FIRE_RATE_PER_UPGRADE = 0.12;
/** Ennemis traverses en plus par carte « perforation ». */
export const PIERCE_PER_UPGRADE = 1;
/** Duree de vie gagnee par carte « portee », en fraction. */
export const RANGE_PER_UPGRADE = 0.2;
/** Echelle gagnee par carte « calibre », en fraction. */
export const CALIBRE_PER_UPGRADE = 0.3;
/** Vitesse gagnee par carte « velocite », en fraction. */
export const VELOCITY_PER_UPGRADE = 0.25;
/**
 * Rayon d'explosion ajoute par carte « detonation », en pixels monde.
 *
 * ⚠️ **Une explosion est un balayage en O(horde) par impact** (`damageInRadius`) :
 * la carte n'est offerte qu'a des armes LENTES, jamais au lance-flammes.
 */
export const DETONATION_RADIUS = 30;
/**
 * Part de chaque impact rendue en poison, par carte « venin ». Plus que la
 * carte « degats » : le poison arrive en retard et se perd sur un ennemi deja
 * mort.
 */
export const VENOM_PER_UPGRADE = 0.4;
/** Rebonds gagnes par carte « ricochet ». */
export const RICOCHET_PER_UPGRADE = 1;
/** Guidage gagne par carte « guidage », en radians par seconde. */
export const HOMING_PER_UPGRADE = 3;
/** Jusqu'ou un ricochet cherche sa cible suivante, en pixels monde. */
export const RICOCHET_RANGE = 260;
/**
 * Duree de vie minimale rendue a un projectile qui ricoche, en ticks : sans
 * elle, un rebond en fin de course mourrait avant d'arriver.
 */
export const RICOCHET_MIN_LIFE_TICKS = 12;
/** Jusqu'ou un projectile guide voit une cible, en pixels monde. */
export const HOMING_RANGE = 420;

/**
 * Les mouvements d'un projectile, et leur code sur le
 * `Uint8Array` de `Projectiles`. `droit` vaut 0 : un tableau neuf est droit.
 */
export const MOTION = { droit: 0, orbite: 1, boomerang: 2, mortier: 3, sinus: 4 } as const;
export type Motion = keyof typeof MOTION;
/** Rayon de l'orbite autour de l'ancre, en pixels monde. */
export const ORBIT_RADIUS = 72;
/** Le rayon de l'orbite respire de ± cette fraction. */
export const ORBIT_BREATH = 0.1;
/** Periode de cette respiration, en ticks. */
export const ORBIT_BREATH_TICKS = 30;
/** Tours par seconde d'un projectile en orbite. */
export const ORBIT_TURNS_PER_S = 0.9;
/**
 * Age minimal (ticks) entre deux contacts d'un projectile jamais consomme
 * (orbite, boomerang) avec le MEME ennemi.
 */
export const REHIT_TICKS = 20;
/** Un boomerang qui revient disparait a moins de cette distance du tireur. */
export const BOOMERANG_CATCH_PX = 24;
/** Rotation de l'angle de base d'une salve en spirale, par tick de tir. */
export const SPIRAL_RAD_PER_TICK = 0.35;
/** Hauteur de la cloche d'un mortier a mi-vol — rendu seul, la simulation reste au sol. */
export const MORTAR_APEX_PX = 90;
/** Ecart lateral maximal d'un projectile en sinus autour de sa ligne, en pixels monde. */
export const SINUS_AMPLITUDE = 36;
/** Periode de l'ondulation, en ticks. */
export const SINUS_PERIOD_TICKS = 12;
/** Degats d'un eclat, en fraction des degats du projectile qui eclate. */
export const FRAGMENT_DAMAGE_RATIO = 0.35;
/** Echelle d'un eclat, en fraction de celle du projectile qui eclate. */
export const FRAGMENT_SCALE_RATIO = 0.5;
/** Vie d'un eclat, en ticks. */
export const FRAGMENT_LIFE_TICKS = 8;

const WEAPON_DEFS: readonly (Omit<
  Weapon,
  | 'id'
  | 'element'
  | 'blastRadius'
  | 'pierce'
  | 'kind'
  | 'projectileScale'
  | 'venom'
  | 'bounces'
  | 'homing'
> & {
  bounces?: number;
  homing?: number;
  element?: number;
  blastRadius?: number;
  pierce?: number;
  kind?: WeaponKind;
})[] = [
  {
    // Arme neutre de base : faible, sans element, hors slots.
    //
    // Portee et cadence assez hautes pour engager la horde tot et suivre le
    // rythme de la premiere vague : trop basses, la premiere montee de niveau
    // devient inatteignable avant que le joueur ne meure encercle.
    name: 'Dague',
    perks: [UPGRADE.SALVO, UPGRADE.PIERCE, UPGRADE.RICOCHET, UPGRADE.VENOM],
    // Lame d'acier, etroite et sobre : l'arme que tout le monde porte ne doit
    // jamais voler la vedette aux autres, d'ou le blanc bleute et le halo
    // le plus discret du catalogue.
    look: {
      shape: 'lame',
      diameterPx: 11,
      tint: 0xeaf2ff,
      glow: 0.3,
      trailTicks: 1,
      spinTurns: 0,
      trail: 'lisse',
    },
    cooldownTicks: 4,
    damage: 5,
    projectileSpeed: 650,
    projectileLifeTicks: 28,
    projectileCount: 1,
    spreadRadians: 0.05,
  },
  {
    // ⚠️ **Une SPIRALE, sans type d'arme de plus** : deux bras opposes dont
    // l'angle tourne avec le tick (`emission: 'spirale'`,
    // `SPIRAL_RAD_PER_TICK`) et ignore la visee. SALVO ajoute un bras.
    //
    // Neutre, et c'est son interet : ses lames tournent tout autour sans
    // viser, donc elle repond a l'ENCERCLEMENT quand les autres demandent de
    // choisir un cote.
    name: 'Roue de lames',
    perks: [UPGRADE.SALVO, UPGRADE.RANGE, UPGRADE.CALIBRE, UPGRADE.VENOM],
    // Lame cramoisie, et la deuxieme plus tournante du catalogue apres le
    // chakram : ce qui part dans toutes les directions doit se lire comme un
    // tourbillon. Le plus petit calibre du catalogue : 3
    // degats par lame, et la taille suit les degats.
    look: {
      shape: 'lame',
      diameterPx: 9,
      tint: 0xff2f6b,
      glow: 0.4,
      trailTicks: 1,
      spinTurns: 2,
      trail: 'lisse',
    },
    cooldownTicks: 4,
    damage: 3,
    projectileSpeed: 520,
    projectileLifeTicks: 20,
    projectileCount: 2,
    // Sans effet en spirale : les bras se repartissent sur le tour quel que
    // soit l'angle (voir `#emit`). Renseigne pour la regle « tout positif ».
    spreadRadians: Math.PI,
    emission: 'spirale',
  },
  {
    // Cadence lente, degats et portee eleves : prouve que la forme couvre
    // aussi l'extreme oppose du DPS instantane.
    //
    // ⚠️ **ELLE TRANSPERCE**, et c'est sa portee qui le justifie : la seule
    // arme dont le projectile traverse assez de terrain pour rencontrer une
    // file d'ennemis. Faible sur une cible isolee, forte sur une file : le
    // prix du transpercage est de VISER une file. Degats PLEINS a chaque
    // traversee (voir `Weapon.pierce`).
    //
    // Elle GROSSIT en vol (`growth`, dessin ET touche) : elle se reconnait a
    // ce qu'elle enfle.
    name: 'Arc lourd',
    perks: [UPGRADE.PIERCE, UPGRADE.SALVO, UPGRADE.DETONATION, UPGRADE.VELOCITY],
    // Le trait le plus gros et le plus long du catalogue — et il ne s'eteint
    // JAMAIS en vol : sa vie (50 ticks) depasse
    // `PROJECTILE_FADE_REFERENCE_TICKS`, donc `projectileAlpha` le laisse a
    // pleine opacite jusqu'au bout. « Il file net », par derivation.
    look: {
      shape: 'fleche',
      diameterPx: 28,
      tint: 0x9a5cff,
      glow: 0.25,
      trailTicks: 1.6,
      spinTurns: 0,
      trail: 'lisse',
    },
    cooldownTicks: 36,
    damage: 25,
    projectileSpeed: 600,
    projectileLifeTicks: 50,
    projectileCount: 1,
    spreadRadians: 0.05,
    pierce: 4,
    growth: 1.5,
  },
  {
    // Cadence tres rapide, courte portee : un jet continu au contact.
    //
    // Braise : elle entretient la marque au contact, la grenade frappe.
    //
    // ⚠️ **`projectileSpeed` au-dessus de `PLAYER_SPEED`**, avec de la marge :
    // sinon la flamme reste COLLEE au joueur qui avance. Voir
    // `MIN_MUZZLE_SPEED`.
    //
    // La plus forte en degats par seconde, pour de tres loin la plus courte
    // portee.
    //
    // ⚠️ **La cadence (3 ticks) ne bouge PAS** : c'est elle qui fait le jet
    // continu, et la ralentir ferait de la dague l'arme la plus rapide du
    // catalogue, ce qu'un test interdit (l'arme gratuite serait meilleure que
    // la carte).
    name: 'Lance-flammes',
    perks: [UPGRADE.RANGE, UPGRADE.SALVO, UPGRADE.CALIBRE],
    // ⚠️ 12 ticks de vie, donc l'usure la plus precoce du catalogue
    // (`projectileWear`) : la langue de feu se consume en vol au lieu de
    // disparaitre d'un coup a bout de portee. Halo le plus
    // fort, trainee la plus courte : tout se passe au contact.
    look: {
      shape: 'flamme',
      diameterPx: 17,
      tint: 0xff4d2e,
      glow: 0.7,
      trailTicks: 1,
      spinTurns: 0,
      trail: 'fumee',
    },
    cooldownTicks: 3,
    damage: 7,
    projectileSpeed: 460,
    projectileLifeTicks: 11,
    projectileCount: 1,
    spreadRadians: 0.6,
    element: ELEMENT.BRAISE,
  },
  {
    // Cadence tres lente, degats massifs : l'extreme oppose du lance-flammes.
    //
    // ⚠️ **L'ARME DE ZONE DU CATALOGUE**, celle dont le tir DOIT peser :
    // cadence la plus lente, degats les plus eleves, plus grand souffle.
    //
    // `blastRadius` vaut `ZONE_RADIUS` : le champ que la reaction laisse au sol
    // couvre exactement la surface que l'explosion vient de frapper, donc le
    // joueur voit ou son tir a porte.
    //
    // Mesure au banc `kills` : le souffle multiplie l'apport de la grenade,
    // mais ne referme pas l'ecart morts/apparitions (meme un rayon absurde
    // n'y arrive pas). Le levier de la horde n'est pas la surface d'une arme.
    //
    // ⚠️ **Elle ECLATE** (`fragments: 8`). Consommee a l'impact ou
    // en fin de course, elle projette huit eclats en couronne (35 % de ses
    // degats chacun, ~120 px de vol) : elle se reconnait au shrapnel, plus
    // seulement a sa teinte. Elle reste la plus forte et la plus lente des
    // armes lancees.
    name: 'Grenade',
    perks: [UPGRADE.ZONE, UPGRADE.SALVO, UPGRADE.VELOCITY],
    // Sphere verte, la plus grosse du catalogue : l'arme la plus forte et la
    // plus lente doit se voir partir.
    look: {
      shape: 'sphere',
      diameterPx: 29,
      tint: 0x39d97a,
      glow: 0.55,
      trailTicks: 1.5,
      spinTurns: 1.2,
      trail: 'fumee',
    },
    cooldownTicks: 45,
    damage: 36,
    projectileSpeed: 460,
    projectileLifeTicks: 34,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.BRAISE,
    blastRadius: ZONE_RADIUS,
    fragments: 8,
  },
  {
    // Milieu de gamme, sert de reference pour les armes voisines.
    //
    // ⚠️ **Trois lames en ORBITE autour du joueur** (`motion: 'orbite'`,
    // `ORBIT_RADIUS`), jamais consommees, qui retouchent un meme ennemi apres
    // `REHIT_TICKS`. Une couronne de protection, la seule arme qui ne part pas
    // devant. Vie = cadence : la couronne suivante nait quand la precedente
    // s'eteint. `projectileSpeed` n'entre pas dans leur course (elles tournent
    // a `ORBIT_TURNS_PER_S`), il reste pour les regles du catalogue.
    //
    // Atouts : une lame de plus (SALVO), CALIBRE, VENOM, RANGE (duree). Plus
    // de PIERCE ni de RICOCHET : elle traverse tout, et ne quitte pas son
    // cercle.
    name: 'Chakram',
    perks: [UPGRADE.SALVO, UPGRADE.CALIBRE, UPGRADE.VENOM, UPGRADE.RANGE],
    // Anneau magenta : la seule forme creuse du catalogue, pour une arme dont
    // le nom EST un disque perce. Trainee courte : en orbite, une longue
    // queue brouillerait la couronne.
    look: {
      shape: 'anneau',
      diameterPx: 15,
      tint: 0xff45c8,
      glow: 0.35,
      trailTicks: 0.6,
      spinTurns: 3.5,
      trail: 'lisse',
    },
    cooldownTicks: 40,
    damage: 6,
    projectileSpeed: 500,
    projectileLifeTicks: 40,
    projectileCount: 3,
    spreadRadians: Math.PI * 2,
    motion: 'orbite',
  },
  {
    // Deux projectiles paralleles, dispersion etroite.
    //
    // Le givre « rapide » : de quoi entretenir des marques de Givre sur un
    // front que la Braise d'un allie viendra faire reagir.
    name: 'Flèches jumelles',
    perks: [UPGRADE.SALVO, UPGRADE.HOMING, UPGRADE.VENOM, UPGRADE.VELOCITY],
    // Aiguille outremer, la plus fine du catalogue : deux traits paralleles
    // doivent se lire comme deux traits, pas comme une tache. Outremer face au
    // turquoise du sceptre — les deux armes de Givre ne se ressemblent pas, et
    // ni l'une ni l'autre ne porte le bleu de l'element (0x7ad8ff).
    look: {
      shape: 'aiguille',
      diameterPx: 18,
      tint: 0x2f6bff,
      glow: 0.3,
      trailTicks: 1.5,
      spinTurns: 0,
      trail: 'lisse',
    },
    cooldownTicks: 12,
    damage: 7,
    projectileSpeed: 600,
    projectileLifeTicks: 25,
    projectileCount: 2,
    spreadRadians: 0.15,
    element: ELEMENT.GIVRE,
  },
  {
    // Salve tres large a courte portee : l'extreme de la dispersion.
    name: 'Canon à mitraille',
    perks: [UPGRADE.SALVO, UPGRADE.RANGE, UPGRADE.CALIBRE],
    // Grain citron, le plus petit du catalogue et la plus courte trainee (un
    // demi-tick) : huit projectiles a la fois, chacun doit rester un grain.
    look: {
      shape: 'grain',
      diameterPx: 14,
      tint: 0xd6f22b,
      glow: 0.25,
      trailTicks: 0.5,
      spinTurns: 2.2,
      trail: 'tirets',
    },
    cooldownTicks: 30,
    damage: 6,
    projectileSpeed: 550,
    projectileLifeTicks: 8,
    projectileCount: 8,
    spreadRadians: Math.PI / 2,
  },
  {
    // ⚠️ **LE FAISCEAU.** Il ne pose aucun projectile : a chaque recharge, il
    // fauche TOUT ce qui se tient sur le trait, du joueur jusqu'au bout de sa
    // portee. Le Givre « de placement ».
    //
    // ⚠️ **Le balayage est celui des PROJECTILES** : `distanceToSegmentSquared`
    // (`shared/projectiles.ts`), le segment tenu une image au lieu d'un tick —
    // aucune geometrie nouvelle.
    //
    // ⚠️ **`projectileSpeed` et `projectileLifeTicks` ne sont PAS inertes ici**,
    // contrairement au halo : leur produit donne la LONGUEUR du trait (voir
    // `beamRange`). Seul `blastRadius` change de sens — il devient la
    // demi-largeur.
    name: 'Rayon arcanique',
    perks: [UPGRADE.ZONE, UPGRADE.RANGE],
    kind: 'faisceau',
    /** La demi-largeur du trait : ce qui est a moins de 26 px du rayon est fauche. */
    blastRadius: 26,
    // Eclat turquoise a fort halo : c'est la teinte que le TRAIT prend a
    // l'ecran (voir le miroir cosmetique dans `GameClient`), donc elle reste
    // ce qui identifie l'arme — la forme, elle, ne sert plus a rien ici.
    look: {
      shape: 'eclat',
      diameterPx: 25,
      tint: 0x28e6d0,
      glow: 0.6,
      trailTicks: 1.5,
      spinTurns: 1.6,
      trail: 'etincelles',
    },
    cooldownTicks: 16,
    damage: 16,
    projectileSpeed: 480,
    projectileLifeTicks: 40,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.GIVRE,
  },
  {
    // La foudre « rapide » :
    // deux projectiles par salve, cadence courte. Chaque impact chaine
    // (`ELEMENT.FOUDRE` declenche `chainTargets` dans `resolveProjectileDamage`,
    // back/src/combat.ts) — une arme qui touche souvent seme donc des chaines
    // souvent, la ou une arme lente laisserait l'effet signature de l'element
    // se voir a peine.
    name: 'Bobine Tesla',
    perks: [UPGRADE.SALVO, UPGRADE.RANGE, UPGRADE.HOMING],
    // Zigzag lavande a fort halo, trainee courte criblee d'etincelles, et il
    // scintille a contresens des autres (rotation NEGATIVE) : un arc qui
    // crepite plutot qu'un trait qui file. Distincte de la teinte de
    // l'element (0xf3e94b, jaune) comme l'exige `assertWeaponLooks`.
    look: {
      shape: 'arc',
      diameterPx: 13,
      tint: 0xb388ff,
      glow: 0.75,
      trailTicks: 0.8,
      spinTurns: -4,
      trail: 'etincelles',
    },
    cooldownTicks: 15,
    damage: 6,
    projectileSpeed: 700,
    projectileLifeTicks: 20,
    projectileCount: 2,
    spreadRadians: 0.2,
    element: ELEMENT.FOUDRE,
  },
  {
    // La foudre « lourde » : le premier maillon d'une chaine doit peser pour
    // que Court-circuit (Foudre + Poix, `shared/reactions.ts`) parte d'un coup
    // qui compte, pas d'une piqure.
    //
    // ⚠️ **Une FRAPPE** (`kind: 'frappe'`, `shared/onde-frappe.ts`). Au tir,
    // le point vise a portee ; ses ennemis les plus proches recoivent chacun
    // un eclair `FRAPPE_DELAY_TICKS` plus tard, une pulsation de rayon
    // `blastRadius`. `projectileCount` compte les eclairs (SALVO en ajoute
    // un), `projectileSpeed x projectileLifeTicks` donne la portee (RANGE).
    name: 'Canon à arc',
    perks: [UPGRADE.SALVO, UPGRADE.ZONE, UPGRADE.RANGE],
    kind: 'frappe',
    // Javelot cyan electrique : la teinte est celle de l'eclair qui tombe.
    look: {
      shape: 'javelot',
      diameterPx: 22,
      tint: 0x00e5ff,
      glow: 0.5,
      trailTicks: 1.4,
      spinTurns: 0,
      trail: 'etincelles',
    },
    cooldownTicks: 33,
    damage: 12,
    projectileSpeed: 600,
    projectileLifeTicks: 24,
    projectileCount: 3,
    spreadRadians: 0.05,
    element: ELEMENT.FOUDRE,
    // Le rayon de chaque eclair — le souffle de contact, voir
    // `HEAVY_BLAST_RADIUS`.
    blastRadius: HEAVY_BLAST_RADIUS,
  },
  {
    // ⚠️ **LE HALO.** Il ne tire RIEN : a chaque recharge, il frappe tout ce
    // qui se tient dans son rayon, autour du joueur. La poix « rapide » :
    // etaler la marque sur un front.
    //
    // ⚠️ **Le balayage est celui de la GRENADE**, `damageInRadius`, deja
    // partage avec la reaction elementaire : un halo est une explosion qui se
    // repete sur le joueur, pas un systeme de plus.
    name: 'Encensoir de poix',
    perks: [UPGRADE.ZONE],
    kind: 'halo',
    // ⚠️ **`blastRadius` EST sa portee** : le rayon qui decide de ce qui meurt,
    // exactement comme pour la grenade — et le client en derive le disque
    // qu'il dessine, donc le dessin ne peut pas mentir sur la portee.
    blastRadius: 110,
    // ⚠️ **Quatre reglages INERTES** (`projectileSpeed`, `projectileLifeTicks`,
    // `projectileCount`, `spreadRadians`) : un halo ne pose aucun projectile.
    // Ils restent renseignes et plausibles parce que le catalogue est lu par
    // des derivations qui balaient TOUTES les armes (`PROJECTILE_CULL_MARGIN`,
    // les tests de coherence du catalogue) — une valeur manquante les
    // casserait. Le `kind` ci-dessus dit ce qui compte vraiment.
    look: {
      shape: 'bouffee',
      diameterPx: 10,
      // ⚠️ **Ambre VIF** : la teinte d'une arme de halo n'habille pas un
      // projectile de dix pixels, elle EST le disque qu'on voit battre autour
      // du joueur. Un brun sourd se perdait sur l'herbe.
      tint: 0xe0a53c,
      glow: 0.2,
      trailTicks: 0.8,
      spinTurns: 0.8,
      trail: 'fumee',
    },
    // ⚠️ **12 ticks, et c'est un reglage de LISIBILITE** : une pulsation dure
    // ce que dure son flash (220 ms) ; a 12 ticks (400 ms) l'aura bat presque
    // sans interruption, une recharge plus longue la laisserait eteinte la
    // plupart du temps.
    cooldownTicks: 12,
    damage: 4,
    projectileSpeed: 480,
    projectileLifeTicks: 18,
    projectileCount: 1,
    spreadRadians: 0.4,
    element: ELEMENT.POIX,
  },
  {
    // La poix « lourde » : projectile unique, cadence lente, degats eleves.
    //
    // ⚠️ **Un MORTIER** (`motion: 'mortier'`). Il vole au-dessus de la horde
    // sans toucher personne (`collide` l'ignore) et saute en fin de course,
    // par le souffle de fin de course : on ne vise pas une cible, on vise un
    // POINT. Le rendu le monte en cloche (`MORTAR_APEX_PX`) au-dessus de son
    // ombre.
    name: 'Chaudron à poix',
    perks: [UPGRADE.ZONE, UPGRADE.SALVO, UPGRADE.VENOM],
    // Masse brun fonce, la plus terne du catalogue : une motte informe qui
    // roule sur elle-meme en fumant, sans halo marque, conforme a une arme
    // qui n'illumine rien.
    look: {
      shape: 'masse',
      diameterPx: 23,
      tint: 0x5c3a21,
      glow: 0.15,
      trailTicks: 1.3,
      spinTurns: -1,
      trail: 'fumee',
    },
    cooldownTicks: 40,
    damage: 14,
    projectileSpeed: 460,
    projectileLifeTicks: 26,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.POIX,
    // Souffle de contact : voir `HEAVY_BLAST_RADIUS`. Le seul coup du mortier.
    blastRadius: HEAVY_BLAST_RADIUS,
    motion: 'mortier',
  },
  {
    // ⚠️ **LA MINE, sans type d'arme de plus** : un projectile IMMOBILE a
    // souffle EST une mine. `projectileSpeed: 0` la laisse ou on la pose,
    // `projectileLifeTicks` la fait attendre, `collide` sert de detecteur de
    // proximite, `blastRadius` emporte le voisinage.
    //
    // ⚠️ **Elle se pose AUX PIEDS du joueur**, pas devant : `#emit` depose a la
    // position du tireur, et a vitesse nulle la direction visee n'a plus
    // d'effet. Elle demande de faire passer la horde SUR soi puis de s'ecarter
    // — l'inverse exact du faisceau.
    //
    // ponytail: empiler cette arme pose N mines AU MEME POINT, donc les
    // exemplaires concentrent les degats au lieu de couvrir plus de terrain.
    // Un semis demanderait un deport a l'emission, pas une regle ici.
    name: 'Semoir de chaux',
    perks: [UPGRADE.ZONE, UPGRADE.RANGE, UPGRADE.VENOM],
    // ⚠️ **`blastRadius` est ce que la mine emporte en sautant** — le sens
    // ordinaire du champ, pas le sens detourne du halo et du faisceau.
    blastRadius: 60,
    // Bouffee paille claire, qui TOURNE sur place : une mine posee doit se
    // remarquer au sol sans bouger, et la rotation est le seul mouvement dont
    // elle dispose. Distincte du blanc crayeux de l'element (0xe8dcc0) : la
    // zone au sol dit l'element, pas le projectile (`assertWeaponLooks`).
    look: {
      shape: 'bouffee',
      diameterPx: 27,
      tint: 0xf3ecb8,
      glow: 0.35,
      // ⚠️ **Zero trainee** : `projectileTrailPx` multiplie par la vitesse, qui
      // est nulle — la valeur est donc sans effet, et c'est juste.
      trailTicks: 0.9,
      spinTurns: 0.4,
      trail: 'fumee',
    },
    cooldownTicks: 50,
    damage: 18,
    // ⚠️ **ZERO, et c'est la seule arme du catalogue a y avoir droit** : voir
    // `MIN_MUZZLE_SPEED`, dont la regle est « un projectile part plus vite que
    // son tireur, OU il ne part pas du tout ».
    projectileSpeed: 0,
    // Huit secondes au sol. C'est long pour un projectile et court pour un
    // piege : assez pour que la vague suivante marche dessus, trop peu pour
    // que le terrain se couvre de mines oubliees.
    projectileLifeTicks: 240,
    projectileCount: 1,
    spreadRadians: 0.4,
    element: ELEMENT.CHAUX,
  },
  {
    // La chaux « lourde » : le premier ennemi touche doit deja fuir avant
    // qu'un allie n'ait besoin de suivre.
    //
    // ⚠️ **Une ONDE** (`kind: 'onde'`, `shared/onde-frappe.ts`). Un anneau de
    // chaux part du joueur a `projectileSpeed` jusqu'a `blastRadius` (que ZONE
    // agrandit) et frappe une fois chaque ennemi qu'il franchit. Pas de SALVO
    // ni de CALIBRE : il n'y a pas de projectile a multiplier ou grossir.
    name: 'Canon à chaux',
    perks: [UPGRADE.ZONE],
    kind: 'onde',
    // Os-et-ocre, sourde sans etre sombre (un olive fonce se perdait dans
    // l'herbe) : c'est la teinte de l'anneau, distincte de celle de l'element.
    look: {
      shape: 'obus',
      diameterPx: 24,
      tint: 0xcbbf9a,
      glow: 0.2,
      trailTicks: 1.2,
      spinTurns: 0,
      trail: 'fumee',
    },
    cooldownTicks: 44,
    damage: 15,
    projectileSpeed: 460,
    // Inerte : l'onde vit jusqu'a son rayon max (220 / 460 s, ~15 ticks).
    // Renseigne a cette valeur pour que les regles du catalogue lisent vrai.
    projectileLifeTicks: 15,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.CHAUX,
    /** Le rayon ou l'onde s'eteint. */
    blastRadius: 220,
  },
  {
    // ⚠️ **L'INVOCATION reutilise le halo.** Une invocation est une
    // pulsation de halo dont le centre est `guardCenter` : `resolveHalos` les
    // resout toutes les deux — voir `Guard` et `guardPulsesAt`.
    //
    // ⚠️ **Rien ne transite** : comme un tir, elle est entierement determinee
    // par l'arme, le tick et la position du tireur.
    //
    // ⚠️ **Elle ne DETOURNE PAS la horde, et c'est une limite assumee.** La
    // verser dans le champ de flux, comme `substituteDecoys` le fait pour le
    // leurre, ferait entrer une position predite cote client et arbitree cote
    // serveur dans la seule chose que les deux cotes derivent au pixel pres :
    // toute la horde divergerait. Elle protege en TUANT ce qui approche.
    //
    // ⚠️ **L'homoncule ACCOMPAGNE son invocateur** : ses pulsations partent de
    // la position COURANTE du joueur (`guardCenter`), et sa vie est un
    // multiple de `GUARD_PULSE_TICKS`, si bien que l'aura ne s'interrompt
    // jamais.
    name: 'Homoncule de mercure',
    perks: [UPGRADE.ZONE, UPGRADE.RANGE],
    kind: 'invocation',
    // Le rayon de chaque pulsation — `blastRadius` au sens du halo : ce qui
    // decide de ce qui meurt.
    blastRadius: 120,
    // Masse lilas pale qui tourne sur place : un petit corps de mercure, pas un
    // projectile. La teinte reste celle de l'arme (le client en teinte ses
    // pulsations), distincte de celle de l'element (0xb9b4ff).
    look: {
      shape: 'masse',
      diameterPx: 16,
      tint: 0xd7dcf5,
      glow: 0.3,
      trailTicks: 1.1,
      spinTurns: 0.9,
      trail: 'lisse',
    },
    // Vie et recharge s'enchainent : l'arme ne connait jamais de silence.
    cooldownTicks: 96,
    damage: 6,
    // Elle ne LANCE rien — meme regle que la mine, voir `MIN_MUZZLE_SPEED`.
    projectileSpeed: 0,
    /** La duree de vie de l'invocation, pas celle d'un projectile. */
    projectileLifeTicks: 96,
    projectileCount: 1,
    spreadRadians: 0.18,
    element: ELEMENT.VIF_ARGENT,
  },
  {
    // Le vif-argent « lourd » : le premier maillon d'une liaison doit peser
    // pour que l'allie qui la retrouve trouve deux ennemis deja groupes.
    //
    // ⚠️ **Un BOOMERANG** (`motion: 'boomerang'`). Il part dans la visee en
    // ralentissant jusqu'a l'arret a mi-vie, puis revient vers son tireur a
    // pleine vitesse ; jamais consomme, il touche a l'aller ET au retour
    // (`REHIT_TICKS`). Pas de souffle ni de PIERCE : il traverse tout.
    name: 'Glaive de mercure',
    perks: [UPGRADE.SALVO, UPGRADE.CALIBRE, UPGRADE.RANGE],
    // Lame a garde lilas argente qui tourne sur elle-meme, fort halo : le
    // mercure se voit partir, contrairement a la poix qui n'illumine rien.
    // Assez claire pour ne pas disparaitre sur l'herbe.
    look: {
      shape: 'glaive',
      diameterPx: 21,
      tint: 0xa89bdb,
      glow: 0.5,
      trailTicks: 1.3,
      spinTurns: 2.6,
      trail: 'lisse',
    },
    cooldownTicks: 32,
    damage: 12,
    projectileSpeed: 600,
    projectileLifeTicks: 50,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.VIF_ARGENT,
    motion: 'boomerang',
  },
  {
    // La fronde : un caillou qui ne s'arrete pas au premier. Il rebondit
    // d'ennemi en ennemi (`bounces`) — l'arme des hordes serrees, la ou
    // l'arc lourd veut des files.
    //
    // ⚠️ **Il ONDULE** (`motion: 'sinus'`, `SINUS_AMPLITUDE` px de part et
    // d'autre de sa ligne). La ligne repart de chaque impact.
    name: 'Fronde à ricochets',
    perks: [UPGRADE.RICOCHET, UPGRADE.SALVO, UPGRADE.VELOCITY, UPGRADE.VENOM],
    look: {
      shape: 'grain',
      diameterPx: 19,
      tint: 0xff8a1f,
      glow: 0.35,
      trailTicks: 1.5,
      spinTurns: 2,
      trail: 'tirets',
    },
    cooldownTicks: 24,
    damage: 10,
    projectileSpeed: 620,
    projectileLifeTicks: 26,
    projectileCount: 1,
    spreadRadians: 0.05,
    bounces: 3,
    motion: 'sinus',
  },
  {
    // Le missile : lent, mais il trouve sa cible (`homing`). Le seul tir qui
    // pardonne une visee approximative.
    //
    // ⚠️ **Un ESSAIM** de mini-missiles en eventail qui se rabattent. Pas de
    // souffle — il reste aux armes a projectile unique, voir
    // `HEAVY_BLAST_RADIUS` — ni de ZONE.
    name: 'Missile guidé',
    perks: [UPGRADE.HOMING, UPGRADE.SALVO, UPGRADE.VELOCITY],
    // Dard, et petit : la taille suit les degats d'UN missile.
    look: {
      shape: 'dard',
      diameterPx: 12,
      tint: 0xff3b5c,
      glow: 0.6,
      trailTicks: 3,
      spinTurns: 0,
      trail: 'fumee',
    },
    cooldownTicks: 42,
    damage: 5,
    projectileSpeed: 480,
    projectileLifeTicks: 50,
    projectileCount: 5,
    spreadRadians: 1.6,
    element: ELEMENT.BRAISE,
    homing: 9,
  },
];

export const WEAPONS: readonly Weapon[] = WEAPON_DEFS.map((w, id) => ({
  ...w,
  id,
  element: w.element ?? ELEMENT.NEUTRE,
  blastRadius: w.blastRadius ?? 0,
  pierce: w.pierce ?? 0,
  kind: w.kind ?? 'tir',
  projectileScale: 1,
  venom: 0,
  bounces: w.bounces ?? 0,
  homing: w.homing ?? 0,
  motion: w.motion ?? 'droit',
  emission: w.emission ?? 'visee',
  fragments: w.fragments ?? 0,
  growth: w.growth ?? 0,
}));

/**
 * Verifie que chaque arme designe un element existant.
 *
 * ⚠️ **Prend la table en parametre au lieu de lire `WEAPONS`**, pour une
 * raison de test et une seule : le catalogue est une constante, aucun test ne
 * peut y glisser une reference morte, donc une garde qui ne lirait que
 * `WEAPONS` serait du code qu'aucune mutation ne peut tuer. Avec un parametre,
 * `weapons.test.ts` lui donne une table volontairement cassee et verifie
 * qu'elle leve.
 *
 * Appelee au CHARGEMENT du module, juste en dessous : une table mal formee
 * casse au demarrage, jamais silencieusement au premier tir de l'arme fautive.
 */
export function assertWeaponElements(weapons: readonly Weapon[]): void {
  for (const w of weapons) {
    elementOf(w.element);
  }
}

/**
 * Verifie que chaque apparence se distingue de toutes les autres, et
 * qu'aucune ne se fait passer pour son element.
 *
 * Deux regles, et deux seulement :
 *
 * 1. **Aucune arme ne porte la teinte de son element.** L'element se lit a la
 *    zone au sol et a la marque sur l'ennemi ; un projectile qui la
 *    reprend rendrait les armes neutres indiscernables entre elles — la
 *    teinte de `NEUTRE` est `0xffffff`, l'identite du produit, donc « neutre »
 *    voudrait dire « blanc », et blanc est deja le flash de reaction.
 * 2. **Deux armes ne partagent jamais une teinte.** C'est le canal qu'on lit a
 *    un point de dix pixels en mouvement ; la forme, non. Sans cette regle,
 *    « chaque arme a une apparence » et « toutes les armes ont la MEME
 *    apparence » se ressemblent beaucoup.
 *
 * ⚠️ **Rien sur la FORME.** Exiger des formes deux a deux distinctes
 * interdirait a une arme suivante d'en reutiliser une, donc ferait de
 * « ajouter une arme » de l'architecture. C'est la TEINTE qui distingue,
 * jamais la forme.
 *
 * Prend la table en parametre pour la meme raison que `assertWeaponElements` :
 * le vrai catalogue est une constante, aucun test ne peut y glisser un doublon.
 */
export function assertWeaponLooks(weapons: readonly Weapon[]): void {
  const parTeinte = new Map<number, string>();
  for (const w of weapons) {
    if (w.look.tint === elementOf(w.element).tint) {
      throw new Error(`arme « ${w.name} » : teinte de projectile identique a celle de son element`);
    }
    const jumelle = parTeinte.get(w.look.tint);
    if (jumelle !== undefined) {
      throw new Error(`armes « ${jumelle} » et « ${w.name} » : meme teinte de projectile`);
    }
    parTeinte.set(w.look.tint, w.name);
  }
}

assertWeaponElements(WEAPONS);
assertWeaponLooks(WEAPONS);

/**
 * Duree de vie au-dela de laquelle un projectile ne s'eteint plus du tout,
 * en ticks.
 *
 * ⚠️ **C'est la SEULE constante du fondu**, et l'atténuation de chaque arme
 * s'en deduit avec sa propre `projectileLifeTicks` — voir `projectileAlpha`.
 * La portee est du reglage de jeu : c'est le fondu qui dit qu'une arme porte
 * court.
 *
 * Une arme dont la vie atteint cette valeur « file net » : son fondu vaut
 * exactement zero. `weapons.test.ts` verifie que l'arme de plus longue portee
 * l'atteint.
 */
export const PROJECTILE_FADE_REFERENCE_TICKS = 40;

/**
 * Vitesse MINIMALE d'un projectile, derivee de celle du joueur.
 *
 * ⚠️ **Un projectile doit prendre de l'avance sur le joueur qui le suit,
 * sinon il lui reste colle.** 200 px/s d'avance, c'est un corps de joueur
 * franchi en un sixieme de seconde. `weapons.test.ts` garde le plancher pour
 * toutes les armes lancees.
 *
 * ⚠️ **L'autre remede — faire HERITER au projectile la vitesse du tireur — est
 * ecarte.** Un tir doit etre
 * entierement determine par l'arme, le tick, la position du tireur et la
 * direction visee : quatre choses que serveur et clients possedent deja. La
 * vitesse REELLE du joueur, elle, sort d'un pas de simulation avec collisions
 * et obstacles ; la recopier dans la trajectoire ferait dependre chaque tir
 * d'un accord au pixel pres entre les deux cotes, et un desaccord se verrait
 * en coups annonces puis non confirmes. Un plancher de vitesse regle le
 * symptome sans ouvrir ce contrat.
 */
export const MIN_MUZZLE_SPEED = PLAYER_SPEED + 200;

/**
 * Un projectile de cette arme PART-il ? `false` pour une mine, qui reste ou on
 * la pose.
 *
 * ⚠️ **C'est la regle du plancher, ecrite a l'endroit** : un projectile part
 * plus vite que son tireur, OU il ne part pas du tout. Entre les deux — une
 * vitesse faible mais non nulle — il n'y a que des armes qui se tassent sur le
 * joueur, et c'est exactement ce que `MIN_MUZZLE_SPEED` existe pour interdire.
 * `weapons.test.ts` garde les deux moities.
 */
export function isLaunched(weapon: Weapon): boolean {
  return weapon.projectileSpeed > 0;
}

/**
 * Ticks entre deux pulsations d'une invocation.
 *
 * ⚠️ **Une constante partagee, pas un champ par arme.** La cadence d'une
 * invocation se lit deja ailleurs : `cooldownTicks` dit a quel rythme on en
 * POSE une, `projectileLifeTicks` combien de temps elle tient. Ce qu'il
 * manquait, c'est son rythme de frappe — et tant qu'il n'y a qu'une
 * invocation au catalogue, un champ de plus serait un reglage que personne ne
 * compare.
 *
 * 12 : 2,5 fois par seconde a `TICK_HZ`. La vie de l'homoncule en est un
 * multiple, donc le suivant pulse exactement 12 ticks apres le dernier coup du
 * precedent.
 */
export const GUARD_PULSE_TICKS = 12;

/**
 * Une invocation : un corps qui frappe autour de lui jusqu'a s'eteindre. Il
 * suit son invocateur (`guardCenter`) ; `x`/`y` ne servent que si celui-ci a
 * quitte le salon.
 *
 * ⚠️ **Elle vit dans `shared/` parce que les DEUX cotes la derivent** : le
 * serveur en tire des degats, le client le dessin. Zero octet sur le fil.
 */
export interface Guard {
  readonly x: number;
  readonly y: number;
  readonly bornTick: number;
  /** Combien de ticks elle tient — recopie de `projectileLifeTicks` a la pose. */
  readonly lifeTicks: number;
  /** Rayon de chaque pulsation, exemplaires empiles compris (`effectRadius`). */
  readonly radius: number;
  readonly damage: number;
  readonly element: number;
  /** Le joueur qui l'a posee : c'est LUI que la marque retient, donc lui que la Synergie compare. */
  readonly by: number;
}

/**
 * Le centre d'une pulsation : la position COURANTE de l'invocateur, ou le
 * point de pose s'il n'est plus la. Meme fonction
 * des deux cotes ; `anchor` est la meme que celle des projectiles.
 */
export function guardCenter(
  guard: Guard,
  anchor?: (by: number) => { readonly x: number; readonly y: number } | undefined,
): { readonly x: number; readonly y: number } {
  return anchor?.(guard.by) ?? guard;
}

/** Cette invocation tient-elle encore au tick `tick` ? */
export function guardIsAlive(guard: Guard, tick: number): boolean {
  return tick - guard.bornTick < guard.lifeTicks;
}

/**
 * Cette invocation FRAPPE-t-elle a ce tick ?
 *
 * ⚠️ **Derive du tick, sans aucun compteur a tenir.** Un « prochain coup »
 * stocke sur l'invocation aurait demande au client de le faire avancer
 * exactement comme le serveur, donc une seconde horloge a synchroniser pour
 * rien. Un modulo sur l'age dit la meme chose et ne peut pas deriver.
 *
 * Elle frappe des sa pose (age zero) : une invocation qui attendrait une
 * demi-seconde avant son premier coup se ferait souvent eteindre avant.
 */
export function guardPulsesAt(guard: Guard, tick: number): boolean {
  const age = tick - guard.bornTick;
  return age >= 0 && age < guard.lifeTicks && age % GUARD_PULSE_TICKS === 0;
}

/**
 * Part de sa vie qu'un projectile passe a s'eteindre, de 0 (jamais) a 1 (des
 * son depart). Interne : `projectileAlpha` est la seule regle publique, pour
 * qu'aucune mutation de cette formule ne puisse etre masquee par un test qui
 * la verifierait deux fois.
 */
function fadeFraction(lifeTicks: number): number {
  const brut = 1 - lifeTicks / PROJECTILE_FADE_REFERENCE_TICKS;
  return brut < 0 ? 0 : brut > 1 ? 1 : brut;
}

/**
 * Opacite d'un projectile a `ticksRemaining` ticks de son expiration, pour une
 * arme dont les projectiles vivent `lifeTicks`.
 *
 * ⚠️ **DERIVEE de `projectileLifeTicks`, jamais reglee a cote.** Deux nombres
 * qui decrivent la meme chose finissent par se contredire. Le fondu occupe
 * la part `1 - lifeTicks / REFERENCE` de la vie du projectile : plus la
 * portee est courte, plus tot il commence (70 % pour une vie de 12 ticks, 0 %
 * au-dela de la reference).
 *
 * `ticksRemaining` est le compte a rebours de `Projectiles` (`ticksRemainingAt`),
 * pas un age calcule depuis une horloge : le rendu n'a donc aucun tick a
 * synchroniser avec la simulation pour dessiner le bon fondu.
 */
export function projectileAlpha(lifeTicks: number, ticksRemaining: number): number {
  if (lifeTicks <= 0) {
    return 1;
  }
  const fondu = fadeFraction(lifeTicks);
  const restant = ticksRemaining / lifeTicks;
  // Pas de `if (fondu <= 0) return 1;` : a fondu nul, la comparaison
  // ci-dessous est deja toujours vraie, et la garde serait masquee.
  if (restant >= fondu) {
    return 1;
  }
  return restant < 0 ? 0 : restant / fondu;
}

/**
 * Longueur de la trainee d'une arme, en pixels monde.
 *
 * `look.trailTicks` ticks de vol a `projectileSpeed` : la trainee dessine donc
 * la distance que le projectile vient de parcourir, et pas un nombre choisi a
 * cote de sa vitesse.
 */
export function projectileTrailPx(weapon: Weapon): number {
  return (weapon.projectileSpeed * weapon.look.trailTicks) / TICK_HZ;
}

/**
 * L'arme neutre de base : celle avec laquelle toute run commence.
 *
 * ⚠️ **Elle vit HORS des slots.** Elle ne figure dans aucun `Loadout`, n'est
 * jamais proposee par le draft (voir `buildPool`), et tire quand meme a chaque
 * tick. Ce n'est pas un detail de reglage : si le draft la proposait, la
 * prendre l'empilerait sur elle-meme et la ferait tirer deux fois par tick.
 */
export const BASE_WEAPON_ID = 0;

/**
 * Le role des armes NEUTRES : elles ne declenchent aucune reaction, elles
 * **amplifient** celles que les allies preparent. Un tir neutre sur un ennemi
 * qui porte une marque d'element inflige ses degats multiplies par ce facteur.
 *
 * ⚠️ **Rien n'est consomme.** La marque reste, l'allie peut encore declencher
 * sa reaction : le neutre recompense de viser ce que l'equipe a marque, il ne
 * lui vole rien. Serveur seul (les PV ennemis ne sont pas sur le fil) : zero
 * octet.
 */
export const NEUTRE_MARQUE_AMP = 1.5;

/** Les armes proposables comme arme de depart : toutes sauf l'arme neutre, deja tenue. */
export function startingWeapons(): number[] {
  return WEAPONS.filter((w) => w.id !== BASE_WEAPON_ID).map((w) => w.id);
}

export function weaponOf(id: number): Weapon {
  const found = WEAPONS[id];
  if (!found) {
    throw new Error(`arme inconnue : ${id}`);
  }
  return found;
}

/**
 * Reduction maximale de cadence, toutes cartes « cadence » confondues.
 *
 * ⚠️ Le bonus est une FRACTION retiree (0,08 par carte) : treize cartes
 * donneraient 1,04, donc une recharge negative — l'arme tirerait a chaque
 * tick, et une quatorzieme ne changerait plus rien puisque le plancher d'un
 * tick est deja atteint. Plafonner ici garde la courbe lisible et laisse la
 * derniere carte utile.
 */
export const MAX_FIRE_RATE_BONUS = 0.75;

/**
 * Nombre de projectiles d'une salve, exemplaires empiles compris.
 *
 * ⚠️ **C'est ici que « l'accumulation des cartes fait la puissance » devient un
 * nombre.** Chaque exemplaire au-dela du premier elargit la salve de
 * `stackGain(arme)` projectiles — un par tranche de trois dans la salve de
 * base —, repartis sur le meme `spreadRadians`. C'est le levier le plus
 * lisible a l'ecran : on VOIT sa salve s'elargir, la ou une reduction de
 * recharge se devine.
 *
 * `stacks` a zero rend le compte de base : l'arme neutre, qui n'est jamais
 * empilee, passe par le meme chemin sans cas particulier.
 */
export function salvoCount(weapon: Weapon, stacks: number): number {
  return weapon.projectileCount + Math.max(0, stacks - 1) * stackGain(weapon);
}

/**
 * De combien le rayon d'effet d'une arme SANS projectile grandit par
 * exemplaire empile, en fraction.
 *
 * ⚠️ **C'est l'equivalent de `salvoCount` pour les armes qui ne tirent pas.**
 * « L'accumulation des cartes fait la puissance » doit valoir pour
 * toutes les familles, sinon une carte de halo ou de faisceau ne vaudrait rien
 * a partir de la deuxieme. Le rayon plutot que les degats : c'est le levier le
 * plus LISIBLE a l'ecran, exactement l'argument qui fait grandir la salve d'un
 * tir.
 */
export const EFFECT_RADIUS_PER_STACK = 0.15;

/**
 * Rayon d'effet d'une arme sans projectile, exemplaires empiles compris : la
 * portee du cercle pour un `'halo'`, la demi-largeur du trait pour un
 * `'faisceau'`.
 *
 * ⚠️ **Une seule regle pour les deux familles, et c'est deliberé.** Deux
 * fonctions identiques a un nom pres auraient fini par diverger au premier
 * reglage.
 *
 * `stacks` a zero rend le rayon de base, comme `salvoCount` : aucune famille
 * n'a de cas particulier pour l'arme neutre, qui n'est jamais empilee.
 */
export function effectRadius(weapon: Weapon, stacks: number): number {
  return weapon.blastRadius * (1 + EFFECT_RADIUS_PER_STACK * Math.max(0, stacks - 1));
}

/**
 * Portee d'un faisceau, en pixels monde — la MEME derivation que la portee
 * d'un tir (`projectileSpeed x projectileLifeTicks / TICK_HZ`).
 *
 * ⚠️ **Et c'est pour ca que ces deux champs ne sont PAS inertes sur un
 * faisceau**, contrairement au halo : un trait a une longueur, et la longueur
 * d'une arme du catalogue se lit deja comme ca partout ailleurs. Reutiliser la
 * formule evite un champ de plus qui dirait la meme chose a cote.
 */
export function beamRange(weapon: Weapon): number {
  return (weapon.projectileSpeed * weapon.projectileLifeTicks) / TICK_HZ;
}

/**
 * L'arme telle que CE joueur la tire : ses bonus propres appliques (salve,
 * zone, perforation, portee). Degats et cadence n'y sont pas — ils se
 * combinent aux passifs la ou le tir se decide.
 *
 * ⚠️ **Tout ce qu'elle change est recopie sur le projectile a l'emission**
 * (`Projectiles`), donc l'impact n'a rien a relire : c'est ce qui permet de
 * passer une copie modifiee au lieu de l'entree du catalogue.
 *
 * Rend l'entree du catalogue elle-meme quand rien n'est ameliore.
 */
export function upgradedWeapon(weapon: Weapon, upgrades: (upgrade: number) => number): Weapon {
  const salvo = upgrades(UPGRADE.SALVO);
  const zone = upgrades(UPGRADE.ZONE);
  const pierce = upgrades(UPGRADE.PIERCE);
  const range = upgrades(UPGRADE.RANGE);
  const calibre = upgrades(UPGRADE.CALIBRE);
  const velocity = upgrades(UPGRADE.VELOCITY);
  const detonation = upgrades(UPGRADE.DETONATION);
  const venom = upgrades(UPGRADE.VENOM);
  const ricochet = upgrades(UPGRADE.RICOCHET);
  const homing = upgrades(UPGRADE.HOMING);
  if (
    salvo + zone + pierce + range + calibre + velocity + detonation + venom + ricochet + homing ===
    0
  ) {
    return weapon;
  }
  return {
    ...weapon,
    projectileCount: salvoCount(weapon, 1 + salvo),
    blastRadius: effectRadius(weapon, 1 + zone) + DETONATION_RADIUS * detonation,
    pierce: weapon.pierce + PIERCE_PER_UPGRADE * pierce,
    projectileLifeTicks: Math.round(weapon.projectileLifeTicks * (1 + RANGE_PER_UPGRADE * range)),
    projectileScale: weapon.projectileScale * (1 + CALIBRE_PER_UPGRADE * calibre),
    projectileSpeed: weapon.projectileSpeed * (1 + VELOCITY_PER_UPGRADE * velocity),
    venom: weapon.venom + VENOM_PER_UPGRADE * venom,
    bounces: weapon.bounces + RICOCHET_PER_UPGRADE * ricochet,
    homing: weapon.homing + HOMING_PER_UPGRADE * homing,
  };
}

/** Les aspects que les cartes de cette arme peuvent porter : degats, cadence, puis ses bonus propres. */
export function upgradesFor(weapon: Weapon): readonly number[] {
  return [UPGRADE.DAMAGE, UPGRADE.FIRE_RATE, ...weapon.perks];
}

/**
 * Projectiles qu'UN exemplaire supplementaire ajoute a la salve — un par
 * tranche de trois dans la salve de base, jamais moins d'un. Un projectile
 * fixe par carte punirait les armes larges : a quatre exemplaires, une arme a
 * projectile unique quadruple ses degats quand une salve de huit n'en gagne
 * qu'un tiers.
 *
 * ⚠️ `PROJECTILE_CAPACITY` n'est qu'un plafond memoire :
 * `truncatedProjectiles` compte ce qui deborde.
 */
export function stackGain(weapon: Weapon): number {
  return Math.max(1, Math.ceil(weapon.projectileCount / 3));
}

/**
 * Recharge d'une arme apres application des passifs de cadence.
 *
 * Le plancher d'UN tick n'est pas cosmetique : a zero, `tick - lastFireTick`
 * vaut toujours au moins la recharge et l'arme tirerait plusieurs fois par
 * tick si la boucle changeait.
 *
 * ⚠️ **Vit dans `shared/`** : `GameClient#fireWeapons` est le miroir
 * cosmetique de `Room#fireWeapons`, et deux copies de cette formule
 * divergeraient des la premiere retouche. Le client ne peut pas importer
 * `back/` (regle Biome).
 */
export function cooldownWithBonus(base: number, bonus: number): number {
  const reduction = Math.min(Math.max(bonus, 0), MAX_FIRE_RATE_BONUS);
  return Math.max(1, Math.round(base * (1 - reduction)));
}
