/**
 * Les armes, pilotees par la donnee (§5.1 de la spec).
 *
 * Meme principe que `shared/archetypes.ts`, et meme raison : le §9.1 rappelle
 * que Riot a deplace son spawn du script vers de la donnee pour tenir la
 * charge. Un systeme unique lit cette table ; ajouter une arme au pool des
 * quarante du §6.2 sera du contenu, pas de l'architecture.
 *
 * ⚠️ **Une arme ne monte PAS de niveau.** Elle s'EMPILE, exactement comme un
 * passif : chaque carte prise ajoute un exemplaire, et c'est l'accumulation
 * qui fait la puissance. Les niveaux d'arme et les evolutions ont existe un
 * temps dans cette etape puis ont ete retires — voir le §9 de la spec.
 */

import { TICK_HZ, ZONE_RADIUS } from './constants';
import { ELEMENT, elementOf } from './elements';

/**
 * Les formes de projectile connues (etape 5a, tache 12).
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
  | 'eclat';

/**
 * L'apparence du projectile d'une arme.
 *
 * ⚠️ **La teinte n'est PAS celle de l'element, et `assertWeaponLooks` le
 * refuse.** Une arme neutre doit rester reconnaissable, et deux armes du meme
 * element doivent se distinguer l'une de l'autre : l'element se lit a la zone
 * qu'elle laisse au sol (`ZoneRenderer`) et a la marque sur l'ennemi, pas au
 * point lumineux qui vole. Neuf armes, neuf teintes.
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
   */
  diameterPx: number;
  /** Teinte du projectile, 0xRRGGBB. Voir l'avertissement ci-dessus. */
  tint: number;
  /** Intensite du halo, de 0 (aucun) a 1 (aussi opaque que le corps). */
  glow: number;
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

export interface Weapon {
  id: number;
  name: string;
  /** Cadence de tir, en ticks. */
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
   * verrait qu'au premier tir de cette arme, plusieurs taches plus tard.
   * `assertWeaponElements` ci-dessous verifie chaque reference au CHARGEMENT
   * du module plutot que d'attendre le tir.
   */
  element: number;
  /**
   * Rayon de l'explosion a l'impact, en pixels monde. `0` : le projectile ne
   * touche que ce qu'il percute — etape 6a, tache 16, sur retour de jeu :
   * *« les ennemis sont trop nombreux par rapport aux degats des armes, il
   * faut parfois des AoE sur certaines armes comme les grenades »*.
   *
   * ⚠️ **Zero n'est pas un cas particulier, c'est une entree de la table.**
   * Meme motif que `ELEMENT.NEUTRE` : huit armes sur neuf valent zero et le
   * restent, donc c'est la ligne ABSENTE qui est le cas courant. Un booleen
   * « arme de zone » plus un rayon a cote se contrediraient des la premiere
   * retouche.
   *
   * ⚠️ **Recopie sur le projectile a l'emission** (`Projectiles`), jamais relu
   * dans le catalogue a l'impact — exactement comme `damage`, `element` et
   * `by`. C'est ce qui fait que le tir ne depend d'aucune table une fois
   * parti, et que `Weapon.id` peut rester le seul champ purement cosmetique
   * du projectile.
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
   * retomberait sur celle d'une autre, et « neuf armes, neuf apparences »
   * redeviendrait « neuf armes, un point lumineux » sans que rien ne le dise.
   */
  look: ProjectileLook;
}

/**
 * L'index dans le tableau **est** l'identifiant, comme pour `ARCHETYPES` :
 * aucune table de correspondance a synchroniser entre serveur et clients.
 *
 * La premiere entree est l'arme neutre de base du §6.1 : faible, sans
 * element, hors slots — celle avec laquelle une run commence toujours.
 *
 * `element` et `blastRadius` sont les seuls champs optionnels : omettre le
 * premier vaut `ELEMENT.NEUTRE` (§4.2 de la spec de l'etape 5a), omettre le
 * second vaut `0`, c'est-a-dire « ce projectile ne touche que ce qu'il
 * percute ». Cinq armes sur neuf sont neutres et le restent — *« un socle pour
 * les joueurs qui ne veulent pas jouer le systeme »* (§6.3 de l'orientation) —
 * et une seule explose : dans les deux cas c'est la ligne ABSENTE qui est le
 * cas courant, et l'exception se lit d'un coup d'oeil.
 */
const WEAPON_DEFS: readonly (Omit<Weapon, 'id' | 'element' | 'blastRadius'> & {
  element?: number;
  blastRadius?: number;
})[] = [
  {
    // Arme neutre de base (§6.1) : faible, sans element, hors slots.
    //
    // ⚠️ Reglage mesure, tache 14 : voir le rapport pour les chiffres. Ces
    // valeurs restaient celles de l'etape 2 — 2 morts/s theoriques contre
    // ~37 apparitions/s en moyenne, la montee de niveau (10 orbes) etait
    // inatteignable avant que le joueur ne meure encercle. La portee et la
    // cadence montent : la portee pour engager la horde plus tot (elle met
    // plusieurs secondes a traverser `ANCHOR_RADIUS`), la cadence pour que le
    // rythme de mise a mort suive celui de la premiere vague, desormais
    // ramenee par `WaveDirector` (voir `waveCountBounds`).
    //
    // Hors slots (§6.1) : jamais proposee par le draft, donc jamais empilee.
    name: 'dague',
    // Lame d'acier, etroite et sobre : l'arme que tout le monde porte ne doit
    // jamais voler la vedette aux huit autres, d'ou le blanc bleute et le halo
    // le plus discret du catalogue.
    look: { shape: 'lame', diameterPx: 10, tint: 0xeaf2ff, glow: 0.3, trailTicks: 1 },
    cooldownTicks: 7,
    damage: 5,
    projectileSpeed: 650,
    projectileLifeTicks: 28,
    projectileCount: 1,
    spreadRadians: 0.05,
  },
  {
    // Plusieurs projectiles en eventail : prouve que la dispersion tient,
    // pas seulement le tir a projectile unique.
    //
    // La braise « large » : cinq projectiles etales sur 60°, donc un front de
    // marques sur toute une vague. Chaque element a besoin d'une arme qui
    // arrose et d'une qui frappe fort — un element qu'on n'applique presque
    // jamais est un systeme qu'on ne sent pas.
    name: 'eventail',
    // Petale ambre. ⚠️ **Ambre, pas orange de Braise** (0xff7a3c) : c'est la
    // zone au sol qui dit l'element, pas le projectile — et la grenade, Braise
    // elle aussi, part sur un vert franc pour qu'on ne confonde jamais les
    // deux (voir `assertWeaponLooks`).
    look: { shape: 'petale', diameterPx: 11, tint: 0xffc23d, glow: 0.45, trailTicks: 1 },
    cooldownTicks: 45,
    damage: 4,
    projectileSpeed: 420,
    projectileLifeTicks: 12,
    projectileCount: 5,
    spreadRadians: Math.PI / 3,
    element: ELEMENT.BRAISE,
  },
  {
    // Cadence lente, degats et portee eleves : prouve que la forme couvre
    // aussi l'extreme oppose du DPS instantane.
    name: 'arc-lourd',
    // Le trait le plus gros, le plus rapide et le plus long du catalogue — et
    // le seul qui ne s'eteint JAMAIS en vol : sa vie (40 ticks) atteint
    // `PROJECTILE_FADE_REFERENCE_TICKS`, donc `projectileAlpha` le laisse a
    // pleine opacite jusqu'au bout. « Il file net », par derivation.
    look: { shape: 'fleche', diameterPx: 17, tint: 0x9a5cff, glow: 0.25, trailTicks: 1.6 },
    cooldownTicks: 60,
    damage: 25,
    projectileSpeed: 900,
    projectileLifeTicks: 40,
    projectileCount: 1,
    spreadRadians: 0.05,
  },
  {
    // Cadence tres rapide, courte portee : un cone continu au contact.
    //
    // ⚠️ **Elle reste NEUTRE, et c'est un choix contre son nom.** C'etait la
    // Braise evidente ; elle tire 18 projectiles par seconde (3 toutes les 5
    // ticks). A une zone au sol par projectile qui finit sa course — le modele
    // du §5.1 jusqu'a la tache 21 — et `ZONE_LIFETIME_TICKS` a 90, elle
    // portait a elle seule ~54 zones vivantes par joueur, la ou le §5.3
    // budgete *« quelques dizaines »* pour la partie entiere, et le
    // recouvrement de zones est en O(zones²).
    //
    // ⚠️ **CETTE RAISON A DISPARU a la tache 21** : un projectile ne pose plus
    // rien, c'est la REACTION qui laisse un champ, et les reactions sont
    // bornees a une par ennemi et par tick (§6.2). Une arme rapide ne peut donc
    // plus multiplier les zones. **Ce qui reste, c'est une question de
    // contenu** — une Braise de plus dans un catalogue qui en porte deja — et
    // elle appartient a l'auteur, pas a une contrainte de cout. Signale, pas
    // tranche ici.
    name: 'lance-flammes',
    // ⚠️ **Le cas que la tache 12 nomme** : 10 ticks de vie, donc le fondu le
    // plus long du catalogue (`projectileAlpha` en tire 75 % de sa vie). La
    // langue de feu s'eteint en vol au lieu de disparaitre d'un coup a bout de
    // portee — c'est ce que l'auteur voyait manquer en jouant. Halo le plus
    // fort, trainee la plus courte : tout se passe au contact.
    look: { shape: 'flamme', diameterPx: 13, tint: 0xff4d2e, glow: 0.7, trailTicks: 1 },
    cooldownTicks: 5,
    damage: 3,
    projectileSpeed: 300,
    projectileLifeTicks: 10,
    projectileCount: 3,
    spreadRadians: 0.6,
  },
  {
    // Cadence tres lente, degats massifs : l'extreme oppose du lance-flammes.
    //
    // La braise « lourde » : une zone toutes les deux secondes et demie, posee
    // ou l'explosion finit. Elle et l'eventail couvrent les deux extremes de
    // cadence du catalogue, ce qui donne a la Braise une arme de couverture et
    // une arme de placement.
    //
    // ⚠️ **LA SEULE ARME DE ZONE DU CATALOGUE** (tache 16), et c'est elle qu'il
    // fallait servir en premier : cadence la plus lente (75 ticks) et degats
    // les plus eleves (40), c'est l'arme dont le tir DOIT peser. Une AoE sur le
    // lance-flammes (5 ticks) ne serait pas la meme demande.
    //
    // `blastRadius` vaut `ZONE_RADIUS` : le champ que la reaction laisse au sol
    // couvre exactement la surface que l'explosion vient de frapper, donc le
    // joueur voit ou son tir a porte. Un rayon plus large tuerait hors du
    // dessin, un rayon plus etroit rendrait le champ trompeur — c'est le meme
    // raisonnement que `REACTION_RADIUS`, cale sur le flash qu'il doit couvrir.
    //
    // ⚠️ **MESURE au banc `kills` (4 joueurs immobiles, 60 s, 12 graines), la
    // grenade en main du premier tick :**
    //
    // | Rayon | morts/s | morts / apparitions | horde finale |
    // | --- | --- | --- | --- |
    // | sans grenade | 3,32 | 0,49 | 209 |
    // | 0 (avant) | 3,36 | 0,49 | 207 |
    // | **70** | **3,54** | **0,53** | **192** |
    // | 105 | 3,61 | 0,53 | 192 |
    // | 400 (temoin absurde) | 4,01 | 0,59 | 168 |
    //
    // ⚠️ **Le souffle multiplie par 5,5 ce que la grenade apporte** (+0,04
    // morts/s sans lui, +0,22 avec), et c'est bien l'effet demande. **Mais il
    // ne referme PAS l'ecart dont l'auteur se plaint** : le rapport
    // morts/apparitions passe de 0,49 a 0,53, il reste sous 1, la horde
    // continue de grossir. Le temoin a 400 le dit — meme un rayon absurde ne
    // depasse pas 0,59. **Le levier n'est pas la surface d'une arme, c'est la
    // cadence de la grenade (75 ticks) et le taux de touche de la dague.**
    // Signale, pas tranche ici : c'est du reglage, et il appartient a l'auteur.
    name: 'grenade',
    // Sphere verte, la plus grosse du catalogue : une arme a 40 degats et 75
    // ticks de recharge doit se voir partir. Vert franc face a l'ambre de
    // l'eventail — les deux armes de Braise ne se ressemblent pas.
    look: { shape: 'sphere', diameterPx: 18, tint: 0x39d97a, glow: 0.55, trailTicks: 1.5 },
    cooldownTicks: 75,
    damage: 40,
    projectileSpeed: 350,
    projectileLifeTicks: 45,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.BRAISE,
    blastRadius: ZONE_RADIUS,
  },
  {
    // Milieu de gamme, sert de reference pour les armes voisines.
    name: 'chakram',
    // Anneau magenta : la seule forme creuse du catalogue, pour une arme dont
    // le nom EST un disque perce.
    look: { shape: 'anneau', diameterPx: 14, tint: 0xff45c8, glow: 0.35, trailTicks: 1.5 },
    cooldownTicks: 35,
    damage: 12,
    projectileSpeed: 500,
    projectileLifeTicks: 35,
    projectileCount: 1,
    spreadRadians: 0.05,
  },
  {
    // Deux projectiles paralleles, dispersion etroite.
    //
    // Le givre « rapide », en face de l'eventail : trois projectiles par
    // seconde, de quoi entretenir des marques de Givre sur un front que la
    // Braise d'un allie viendra faire reagir (§6.2).
    name: 'fleches-jumelles',
    // Aiguille outremer, la plus fine du catalogue : deux traits paralleles
    // doivent se lire comme deux traits, pas comme une tache. Outremer face au
    // turquoise du sceptre — les deux armes de Givre ne se ressemblent pas, et
    // ni l'une ni l'autre ne porte le bleu de l'element (0x7ad8ff).
    look: { shape: 'aiguille', diameterPx: 9, tint: 0x2f6bff, glow: 0.3, trailTicks: 1.5 },
    cooldownTicks: 20,
    damage: 7,
    projectileSpeed: 600,
    projectileLifeTicks: 25,
    projectileCount: 2,
    spreadRadians: 0.15,
    element: ELEMENT.GIVRE,
  },
  {
    // Salve tres large a courte portee : l'autre extreme de la dispersion,
    // face a `eventail`.
    name: 'canon-a-mitraille',
    // Grain citron, le plus petit du catalogue et la plus courte trainee (un
    // demi-tick) : huit projectiles a la fois, chacun doit rester un grain.
    look: { shape: 'grain', diameterPx: 7, tint: 0xd6f22b, glow: 0.25, trailTicks: 0.5 },
    cooldownTicks: 50,
    damage: 6,
    projectileSpeed: 550,
    projectileLifeTicks: 8,
    projectileCount: 8,
    spreadRadians: Math.PI / 2,
  },
  {
    // Arme a projectile unique et longue portee. Elle a un temps ete la seule
    // du catalogue a « evoluer » ; les evolutions n'existent plus (§9.1 de la
    // spec), elle s'empile comme les autres.
    //
    // Le givre « de placement » : projectile unique, longue portee, cadence
    // moyenne — une zone posee ou on la vise, en face des fleches-jumelles.
    name: 'sceptre-arcanique',
    // Eclat turquoise a fort halo : l'arme « de placement » du Givre se vise,
    // donc elle se suit des yeux.
    look: { shape: 'eclat', diameterPx: 12, tint: 0x28e6d0, glow: 0.6, trailTicks: 1.5 },
    cooldownTicks: 40,
    damage: 10,
    projectileSpeed: 480,
    projectileLifeTicks: 30,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.GIVRE,
  },
];

export const WEAPONS: readonly Weapon[] = WEAPON_DEFS.map((w, id) => ({
  ...w,
  id,
  element: w.element ?? ELEMENT.NEUTRE,
  blastRadius: w.blastRadius ?? 0,
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
 * casse au demarrage, jamais silencieusement au premier tir de l'arme fautive
 * — plusieurs taches plus tard. C'est le motif que `evolutionPassiveId` avait
 * a l'etape 4, retire avec les evolutions.
 */
export function assertWeaponElements(weapons: readonly Weapon[]): void {
  for (const w of weapons) {
    elementOf(w.element);
  }
}

/**
 * Verifie que les neuf apparences se distinguent, et qu'aucune ne se fait
 * passer pour son element.
 *
 * Deux regles, et deux seulement :
 *
 * 1. **Aucune arme ne porte la teinte de son element.** L'element se lit a la
 *    zone au sol et a la marque sur l'ennemi (§6.6) ; un projectile qui la
 *    reprend rendrait les cinq armes neutres indiscernables entre elles — la
 *    teinte de `NEUTRE` est `0xffffff`, l'identite du produit, donc « neutre »
 *    voudrait dire « blanc », et blanc est deja le flash de reaction.
 * 2. **Deux armes ne partagent jamais une teinte.** C'est le canal qu'on lit a
 *    un point de dix pixels en mouvement ; la forme, non. Sans cette regle,
 *    « neuf armes ont une apparence » et « neuf armes ont la MEME apparence »
 *    se ressemblent beaucoup.
 *
 * ⚠️ **Rien sur la FORME.** Exiger neuf formes distinctes interdirait a une
 * dixieme arme d'en reutiliser une, donc ferait de « ajouter une arme » de
 * l'architecture. Le catalogue en donne neuf differentes parce que c'est plus
 * joli, pas parce qu'une garde l'impose.
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
 * L'auteur demandait *« fais-les durer plus longtemps ou fade pour les armes
 * courte portee comme le lance-flammes »* : la portee ne peut pas bouger (elle
 * est du reglage de jeu), donc c'est le fondu qui la dit.
 *
 * 40 est la duree de vie de l'arc-lourd, la plus longue portee reelle du
 * catalogue hors grenade — `weapons.test.ts` le verifie plutot que de le
 * laisser en commentaire. Une arme qui l'atteint « file net » : son fondu vaut
 * exactement zero.
 */
export const PROJECTILE_FADE_REFERENCE_TICKS = 40;

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
 * qui decrivent la meme chose finissent par se contredire — ce depot l'a
 * rencontre trois fois. Le fondu occupe la part `1 - lifeTicks / REFERENCE` de
 * la vie du projectile : plus la portee est courte, plus tot il commence.
 *
 * | Arme | `projectileLifeTicks` | part de vie en fondu |
 * | --- | --- | --- |
 * | canon-a-mitraille | 8 | 80 % |
 * | **lance-flammes** | **10** | **75 %** |
 * | eventail | 12 | 70 % |
 * | dague | 28 | 30 % |
 * | chakram | 35 | 12,5 % |
 * | **arc-lourd** | **40** | **0 % — il file net** |
 * | grenade | 45 | 0 % |
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
  // ⚠️ **Pas de `if (fondu <= 0) return 1;` ici, et c'est deliberé.** Il a
  // existe, et la mutation l'a trouve MASQUE par la comparaison ci-dessous :
  // a fondu nul, `restant >= 0` est deja toujours vrai. Deux gardes qui se
  // couvrent, huitieme occurrence du depot — soldee comme les trois autres,
  // par une suppression de code.
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
 * L'arme neutre de base du §6.1 : celle avec laquelle toute run commence.
 *
 * ⚠️ **Elle vit HORS des slots.** Elle ne figure dans aucun `Loadout`, n'est
 * jamais proposee par le draft (voir `buildPool`), et tire quand meme a chaque
 * tick. Ce n'est pas un detail de reglage : si le draft la proposait, la
 * prendre l'empilerait sur elle-meme et la ferait tirer deux fois par tick.
 */
export const BASE_WEAPON_ID = 0;

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
 * nombre.** Chaque exemplaire au-dela du premier ajoute UN projectile a la
 * salve, reparti sur le meme `spreadRadians`. C'est le levier le plus lisible
 * a l'ecran dans un bullet heaven — on VOIT sa salve s'elargir — la ou une
 * reduction de recharge se devine et ou les degats ne modulent aujourd'hui
 * aucune issue (la pietaille n'a pas de reserve de points de vie).
 *
 * `stacks` a zero rend le compte de base : l'arme neutre, qui n'est jamais
 * empilee, passe par le meme chemin sans cas particulier.
 */
export function salvoCount(weapon: Weapon, stacks: number): number {
  return weapon.projectileCount + Math.max(0, stacks - 1);
}

/**
 * Recharge d'une arme apres application des passifs de cadence.
 *
 * Le plancher d'UN tick n'est pas cosmetique : a zero, `tick - lastFireTick`
 * vaut toujours au moins la recharge et l'arme tirerait plusieurs fois par
 * tick si la boucle changeait.
 *
 * ⚠️ **Vit dans `shared/` et pas dans `back/src/room.ts`, ou elle est nee a la
 * tache 8.** Le client la lit aussi, depuis la tache 9 : `GameClient#fireWeapons`
 * est le miroir cosmetique de `Room#fireWeapons`, et deux copies de cette
 * formule divergeraient des la premiere retouche — les projectiles affiches ne
 * partiraient plus a la cadence de ceux que le serveur arbitre. Le client ne
 * peut pas importer `back/` (regle Biome, voir `room.ts`), donc la fonction
 * descend ici plutot que d'etre recopiee.
 */
export function cooldownWithBonus(base: number, bonus: number): number {
  const reduction = Math.min(Math.max(bonus, 0), MAX_FIRE_RATE_BONUS);
  return Math.max(1, Math.round(base * (1 - reduction)));
}
