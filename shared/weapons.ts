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

import { PLAYER_SPEED, TICK_HZ, ZONE_RADIUS } from './constants';
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
 * Les profils de trainee (etape 8).
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
   * ⚠️ **Les dix-sept calibres ont ete multiplies par 1,4 a l'etape 8** (de 7 a
   * 29 px, contre 5 a 21). La raison est mesuree, pas esthetique : une case
   * d'atlas dessine la silhouette sur 32 px, et a 5 ou 10 px a l'ecran il ne
   * restait rien a lire de ce que la forme disait — constate sur une planche
   * des dix-sept silhouettes rendue a 128 px, ou les defauts de `masse` et
   * `bouffee` se voyaient alors qu'en jeu ils passaient inapercus.
   *
   * ⚠️ **ET LA TAILLE DIT DESORMAIS CE QUE LE COUP PESE** : les dix-sept
   * calibres suivent l'ordre des `damage`, departage par la cadence. C'est la
   * reponse a *« on dirait qu'ils font tous pareil »* : jusque-la, le Canon a
   * chaux (15 degats) etait le plus gros du catalogue et la Grenade (40) le
   * cinquieme — la taille ne portait AUCUNE information, elle etait juste
   * variee. `weapons.test.ts` garde l'ordre, donc une arme ajoutee doit choisir
   * un calibre coherent avec ses degats, ou le dire.
   *
   * Les VALEURS n'ont pas bouge, seul leur ordre d'attribution : les dix-sept
   * restent distinctes deux a deux et couvrent la meme etendue.
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
   * Tours par seconde que la tete fait sur elle-meme en vol, signe (etape 8).
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
 * La FAMILLE d'une arme (etape 8) — *« il faut varier les types, pas que des
 * projectiles »*.
 *
 * ⚠️ **Un discriminant, et le MINIMUM de valeurs possible.** `'tir'` couvre
 * tout ce que le catalogue savait faire jusqu'ici, anneau compris : un tir
 * circulaire n'est pas une famille, c'est une `spreadRadians` qui fait un tour
 * (les lames du Chakram), ou une `emission` en spirale (la Roue de lames). Une
 * valeur n'entre ici que quand la donnee existante ne peut VRAIMENT pas la
 * dire — pour le halo, c'est le cas : il ne part rien, donc aucun reglage de
 * projectile ne le decrit.
 *
 * Etape 12 (§3.4) : `'onde'` (un anneau qui s'agrandit depuis le tireur,
 * chaque ennemi frappe une fois) et `'frappe'` (des impacts differes autour du
 * point vise) — ni l'une ni l'autre ne pose de projectile. Leur logique pure
 * vit dans `shared/onde-frappe.ts`.
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
   * global** (etape 6a, tache 19). La cadence est l'un des rares axes qui
   * distinguent les armes entre elles ; le releve qui a fixe les valeurs
   * actuelles est en tete de `WEAPON_DEFS`.
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
   * Meme motif que `ELEMENT.NEUTRE` : seize armes sur dix-sept valent zero et
   * le restent, donc c'est la ligne ABSENTE qui est le cas courant. Un booleen
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
   * retomberait sur celle d'une autre, et « chaque arme, son apparence »
   * redeviendrait « dix-sept armes, un point lumineux » sans que rien ne le dise.
   */
  look: ProjectileLook;
  /**
   * Nombre d'ennemis SUPPLEMENTAIRES qu'un projectile traverse avant d'etre
   * consomme. `0` — seize armes sur dix-sept — : il meurt sur le premier qu'il
   * touche.
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
   * Comment le projectile se deplace (etape 12, §3.1) — `'droit'` par defaut.
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
 * La premiere entree est l'arme neutre de base du §6.1 : faible, sans
 * element, hors slots — celle avec laquelle une run commence toujours.
 *
 * `element` et `blastRadius` sont les seuls champs optionnels : omettre le
 * premier vaut `ELEMENT.NEUTRE` (§4.2 de la spec de l'etape 5a), omettre le
 * second vaut `0`, c'est-a-dire « ce projectile ne touche que ce qu'il
 * percute ». QUATRE armes sur dix-sept sont neutres — *« un socle pour les
 * joueurs qui ne veulent pas jouer le systeme »* (§6.3 de l'orientation) ;
 * c'etaient cinq avant que le lance-flammes ne passe en Braise a l'etape 8.
 * Cinq explosaient depuis l'etape 8 (la grenade et les quatre lourdes) ;
 * depuis l'etape 12, deux projectiles seulement (grenade, chaudron) — voir
 * `HEAVY_BLAST_RADIUS`. Dans les deux cas c'est la ligne ABSENTE qui reste le cas courant, et l'exception
 * se lit d'un coup d'oeil.
 *
 * ---
 *
 * **LES CADENCES, etape 6a tache 19** — *« ameliore la cadence des armes »*.
 *
 * ⚠️ **MESURE AVANT DE REGLER, et la mesure a dit « ce levier sature ».** Banc
 * `kills` (4 joueurs immobiles, 60 s, 12 graines), un facteur applique a TOUTES
 * les cadences, deux decors : l'arme neutre seule, et quatre armes draftees en
 * plus (`arsenal plein`).
 *
 * | Facteur | Dague | morts/s (dague seule) | rapport | morts/s (arsenal) | rapport | projectiles (pic) |
 * | --- | --- | --- | --- | --- | --- | --- |
 * | 1 (avant) | 7 | 2,58 | **0,41** | 2,82 | **0,45** | 68 |
 * | 0,85 | 6 | 2,64 | 0,42 | 2,92 | 0,46 | 84 |
 * | 0,70 | 5 | 2,70 | 0,43 | 2,97 | 0,47 | 88 |
 * | **0,60 (retenu)** | **4** | **2,77** | **0,44** | **3,01** | **0,47** | **96** |
 * | 0,50 | 4 | 2,77 | 0,44 | 3,04 | 0,48 | 100 |
 * | 0,35 | 2 | 2,99 | 0,48 | 3,52 | 0,52 | 152 |
 * | 0,25 | 2 | 2,99 | 0,48 | 3,61 | 0,53 | 208 |
 * | 0,125 (temoin absurde) | 1 | 3,20 | **0,49** | 3,87 | **0,56** | 296 |
 *
 * ⚠️ **La cadence n'est PAS linéaire, et elle sature bien avant d'etre
 * gratuite** : huit fois plus de tirs ne rendent que +24 % de morts. Le temoin
 * a un tick est a la cadence ce que le rayon de 400 px etait a l'arme de zone
 * (tache 16) — un absurde qui ne referme pas l'ecart. Ce que le releve dit,
 * c'est que le facteur limitant n'est ni les degats ni la cadence mais **la
 * VISEE** : les tirs partent tous dans une direction, et un second tir parti au
 * meme instant vers le meme point traverse la zone que le premier vient de
 * vider. Signale, pas tranche ici.
 *
 * **Le facteur 0,60 est le genou de la courbe** : en-dessous, le gain
 * (0,44 -> 0,48) se paie sur `cooldownWithBonus`. A cadence 4, le passif
 * « cadence » garde quatre valeurs distinctes et reste utile jusqu'a la 8e
 * carte ; a cadence 2, il n'en garde que deux et meurt a la 4e. **Les deux
 * armes les plus rapides sont donc bornees a la main** au lieu de suivre le
 * facteur, et c'est exactement pourquoi la cadence reste une donnee par arme.
 *
 * | Arme | Avant | Apres | Rapport | Pourquoi cette valeur-la |
 * | --- | --- | --- | --- | --- |
 * | lance-flammes | 5 | **3** | ×0,60 | la plus rapide du catalogue, et elle le reste ; on ne descend pas a 2, ou le passif mourrait en quatre cartes. ⚠️ **Et on ne la REMONTE pas non plus** (etape 8) : a 4 ticks elle serait ex aequo avec la dague, a 5 la dague deviendrait la plus rapide du catalogue — ce qu'un test interdit |
 * | dague | 7 | **4** | ×0,57 | l'arme toujours en main : c'est elle que le releve suit. 4 est le plus bas qui garde huit cartes de cadence utiles |
 * | fleches-jumelles | 20 | **12** | ×0,60 | le Givre « rapide » ; entretient ses marques deux fois plus vite pour la reaction d'un allie |
 * | chakram | 35 | **21** | ×0,60 | milieu de gamme, la reference des armes voisines : elle suit le facteur, sinon elle cesse d'etre une reference |
 * | sceptre-arcanique | 40 | **24** | ×0,60 | le Givre « de placement » ; reste plus lent que les fleches-jumelles |
 * | eventail | 45 | **27** | ×0,60 | la Braise « large » ; reste l'extreme lent face au lance-flammes |
 * | canon-a-mitraille | 50 | **30** | ×0,60 | huit projectiles a la fois : la salve doit rester un evenement |
 * | arc-lourd | 60 | **36** | ×0,60 | cadence lente, degats eleves ; reste le second plus lent |
 * | grenade | 75 | **45** | ×0,60 | *« la cadence de la grenade »* que la tache 16 designait ; reste **strictement** la plus lente et la plus forte (un test le garde) |
 *
 * ⚠️ **L'ORDRE des neuf cadences est inchange, et les neuf valeurs restent
 * distinctes.** C'est ce qui fait qu'aucune arme n'a change de nature : la plus
 * rapide est toujours le lance-flammes, la plus lente toujours la grenade.
 */
/**
 * Rayon du souffle des armes LOURDES — la moitie de celui de la grenade.
 *
 * ⚠️ **Derive de `ZONE_RADIUS`, comme celui de la grenade, et moitie moins.**
 * La grenade reste l'arme de zone : son souffle couvre exactement le champ
 * qu'une reaction laisse au sol, et c'est ce qui fait d'elle *« l'arme dont le
 * tir DOIT peser »*. Les quatre lourdes a projectile unique (Canon a arc,
 * Chaudron a poix, Canon a chaux, Glaive de mercure) recoivent un souffle de
 * contact, pas une zone : il touche le voisin immediat, il ne nettoie pas un
 * groupe.
 *
 * ⚠️ **Pourquoi elles, etape 8.** Releve du catalogue : a un exemplaire, ces
 * quatre-la occupaient les quatre dernieres places en degats par seconde
 * (10,5 a 14,5 contre 22 de mediane), et leur seule contrepartie — la marque
 * elementaire — ne rend que si un ALLIE vient la faire reagir. Le banc `kills`
 * de la tache 16 a deja mesure ce levier sur la grenade : le souffle y
 * multipliait par 5,5 son apport (+0,04 morts/s sans lui, +0,22 avec), sans
 * pour autant refermer l'ecart morts/apparitions. C'est donc un releve du
 * plancher, pas une promesse d'equilibre — et il reste a confirmer au banc.
 *
 * ⚠️ **Le souffle appartient aux armes LENTES a projectile unique**, et
 * `weapons.test.ts` le garde par une propriete : une arme rapide a souffle
 * poserait des explosions en continu, ce que le §6.6 refuse exactement comme il
 * refuse un halo permanent.
 *
 * ⚠️ **Etape 12 : des quatre, seul le Chaudron le garde.** Le Glaive revient
 * (il touche deux fois, sans souffle), le Canon a chaux est devenu une onde et
 * le Canon a arc une frappe — dont chaque impact est une pulsation de CE rayon
 * (`blastRadius`, hors famille `'tir'`). Le Missile, devenu essaim, l'a perdu
 * aussi : cinq souffles par salve, c'est l'explosion continue que la regle
 * refuse.
 */
export const HEAVY_BLAST_RADIUS = ZONE_RADIUS / 2;

/**
 * Ce qu'une carte d'arme ameliore quand on possede DEJA l'arme — un seul
 * aspect par carte (retour de jeu : *« les cartes des armes pourraient
 * ameliorer qu'une partie a chaque fois »*).
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
 * Les mouvements d'un projectile (etape 12, §3.1), et leur code sur le
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
    name: 'Dague',
    perks: [UPGRADE.SALVO, UPGRADE.PIERCE, UPGRADE.RICOCHET, UPGRADE.VENOM],
    // Lame d'acier, etroite et sobre : l'arme que tout le monde porte ne doit
    // jamais voler la vedette aux huit autres, d'ou le blanc bleute et le halo
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
    // ⚠️ **LE TIR CIRCULAIRE** (etape 8) — *« il faut varier les types, pas que
    // des projectiles… des tirs circulaires »*.
    //
    // ⚠️ **Il n'a demande AUCUN type d'arme de plus** : une salve dont
    // `spreadRadians` fait un tour complet EST un tir circulaire, et `#emit`
    // ferme l'anneau tout seul (voir sa doc). Une famille de plus pour une
    // valeur de plus dans un champ qui existait deja — meme pari que
    // `ELEMENT.NEUTRE` ou `blastRadius: 0`, ou le cas particulier est une
    // entree de la table et pas une branche.
    //
    // ⚠️ **Elle REMPLACE l'Éventail, elle ne s'ajoute pas** (*« on peut
    // supprimer certaines armes pour eviter d'avoir un pool trop eleve »*).
    // L'Éventail etait la Braise « large » — cinq petales sur 60° a courte
    // portee ; depuis que le lance-flammes est passe en Braise au contact, les
    // deux occupaient la meme case et l'Éventail y etait trois fois plus
    // faible. La Braise retombe a deux armes, et le catalogue reste a dix-sept.
    //
    // Neutre, et c'est son interet : ses lames tournent tout autour sans
    // viser, donc elle repond a l'ENCERCLEMENT quand toutes les autres
    // demandent de choisir un cote. C'est un socle, au sens du §6.3.
    //
    // ⚠️ **ETAPE 12 : la rafale a 360° devient une SPIRALE.** Dix lames d'un
    // coup toutes les 40 ticks ressemblaient a la mitraille en plus large ;
    // deux bras opposes toutes les 4 ticks, dont l'angle tourne avec le tick
    // (`emission: 'spirale'`, `SPIRAL_RAD_PER_TICK`) et ignore la visee, se
    // reconnaissent sans lire le nom. Degats par lame divises par deux pour
    // le meme debit total : 2 x 3 x 30 / 4 = 45 /s, comme 10 x 6 x 30 / 40.
    // SALVO ajoute un bras.
    name: 'Roue de lames',
    perks: [UPGRADE.SALVO, UPGRADE.RANGE, UPGRADE.CALIBRE, UPGRADE.VENOM],
    // Lame cramoisie, et la deuxieme plus tournante du catalogue apres le
    // chakram : ce qui part dans toutes les directions doit se lire comme un
    // tourbillon. Le plus petit calibre du catalogue depuis l'etape 12 : 3
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
    // soit l'angle (voir `#emit`). Renseigne pour la regle « tout positif »,
    // et PAS a un tour : l'anneau du catalogue est desormais le Chakram.
    spreadRadians: Math.PI,
    emission: 'spirale',
  },
  {
    // Cadence lente, degats et portee eleves : prouve que la forme couvre
    // aussi l'extreme oppose du DPS instantane.
    //
    // ⚠️ **ELLE TRANSPERCE (etape 8)**, sur retour de jeu : *« l'arc lourd est
    // nul, il faudra peut-etre qu'il transperce les ennemis vu sa cadence de
    // tir ? »*. Le releve lui donnait raison — 20,8 degats par seconde, sous
    // la mediane du catalogue (22) pour la cadence la DEUXIEME plus lente.
    //
    // ⚠️ **Et c'est sa portee qui le justifie, pas seulement sa cadence.** Elle
    // tire a 1 000 px (1 200 avant l'etape 12), contre 607 pour la dague : la seule arme du catalogue
    // dont le projectile traverse assez de terrain pour rencontrer une file
    // d'ennemis. Trois traversees portaient sa valeur a ~83 degats par seconde
    // sur une file alignee, et la laissent a 20,8 sur une cible isolee — le
    // prix du transpercage est de VISER une file, pas d'etre plus faible.
    //
    // Les degats restent PLEINS a chaque traversee : voir `Weapon.pierce`.
    //
    // ⚠️ **ETAPE 12 : une fleche plus LENTE qui GROSSIT en vol** (`growth`,
    // 1,5 d'echelle par seconde, dessin ET touche) et traverse quatre corps.
    // Elle fendait l'ecran comme les autres traits ; elle se reconnait
    // maintenant a ce qu'elle enfle. 600 px/s pendant 50 ticks : 1 000 px de
    // portee (1 200 avant), le temps de grossir jusqu'a x3,5. Degats et
    // cadence inchanges : 20,8 /s sur une cible, plus sur une file.
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
    // ⚠️ **ENFIN BRAISE (etape 8), et c'est l'auteur qui a tranche** : *« c'est
    // etrange que lance-flamme soit neutre non ? »*. Elle l'etait pour une
    // raison de COUT, pas de contenu : elle tirait 18 projectiles par seconde,
    // et tant qu'un projectile posait une zone au sol en finissant sa course
    // (le modele du §5.1 jusqu'a la tache 21), elle portait a elle seule ~54
    // zones vivantes par joueur la ou le §5.3 en budgete *« quelques
    // dizaines »* pour la partie entiere — avec un recouvrement en O(zones²).
    //
    // ⚠️ **Cette raison est morte a la tache 21** : un projectile ne pose plus
    // rien, c'est la REACTION qui laisse un champ, et les reactions sont
    // bornees a une par ennemi et par tick (§6.2). Le commentaire disait deja
    // que ce qui restait etait *« une question de contenu, qui appartient a
    // l'auteur »* — la voici tranchee. La Braise garde DEUX armes : la grenade
    // frappe, le lance-flammes entretient la marque au contact, et l'Éventail
    // qui tenait la place de l'arroseuse a cede la sienne a la Roue de lames
    // (voir plus haut) — il faisait desormais doublon avec ce jet.
    //
    // ⚠️ **Et elle ressemble enfin a un lance-flammes (etape 8).** Trois
    // defauts, tous signales en jouant : *« la portee est toute petite, quand
    // on avance dans la meme direction les tirs sont sur moi, tres rapide et
    // petit, ca fait pas lance-flamme »*.
    //
    // | | Avant | Apres | Pourquoi |
    // | --- | --- | --- | --- |
    // | `projectileSpeed` | 300 | **460** | `PLAYER_SPEED` vaut **260** : a 300, une flamme ne prenait que 40 px/s d'avance sur le joueur qui la suit, donc elle lui restait COLLEE. Voir `MIN_MUZZLE_SPEED` |
    // | `projectileCount` | 3 | **1** | trois grains minuscules ne font pas une langue de feu ; une bouffee grosse toutes les trois ticks, oui |
    // | `damage` | 3 | **7** | le calibre dessine SUIT les degats (voir `ProjectileLook.diameterPx`) : a 3 degats la flamme etait le plus petit projectile du catalogue, a 7 elle en fait 17 px |
    //
    // Sa portee (169 px) reste de tres loin la plus courte du catalogue, et
    // ses degats par seconde passent de 90 a 70 : la plus forte, pour la plus
    // courte portee.
    //
    // ⚠️ **La cadence ne bouge PAS (3 ticks).** C'est elle qui fait le jet
    // continu, et c'est aussi une contrainte dure : la ralentir ferait de la
    // dague (4 ticks) l'arme la plus rapide du catalogue, ce qu'un test
    // interdit — *« une dague plus rapide que le lance-flammes rendrait l'arme
    // gratuite meilleure que la carte »*.
    name: 'Lance-flammes',
    perks: [UPGRADE.RANGE, UPGRADE.SALVO, UPGRADE.CALIBRE],
    // ⚠️ **Le cas que la tache 12 nomme** : 12 ticks de vie, donc l'usure la
    // plus precoce du catalogue (`projectileWear` en tire 70 % de sa vie). La
    // langue de feu se consume en vol au lieu de disparaitre d'un coup a bout
    // de portee — c'est ce que l'auteur voyait manquer en jouant. Halo le plus
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
    // La braise « lourde » : une zone toutes les deux secondes et demie, posee
    // ou l'explosion finit. Elle et l'eventail couvrent les deux extremes de
    // cadence du catalogue, ce qui donne a la Braise une arme de couverture et
    // une arme de placement.
    //
    // ⚠️ **L'ARME DE ZONE DU CATALOGUE** — la seule jusqu'a l'etape 8, qui a
    // donne un souffle de CONTACT (moitie moins large, `HEAVY_BLAST_RADIUS`)
    // aux quatre lourdes a projectile unique. La grenade garde le plus grand
    // souffle du catalogue, et c'est elle qu'il
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
    //
    // ⚠️ **ETAPE 12 : elle ECLATE** (`fragments: 8`). Consommee a l'impact ou
    // en fin de course, elle projette huit eclats en couronne (35 % de ses
    // degats chacun, ~120 px de vol) : elle se reconnait au shrapnel, plus
    // seulement a sa teinte. Ses degats passent de 40 a 36 pour payer une part
    // des eclats — elle reste la plus forte et la plus lente des armes lancees.
    name: 'Grenade',
    perks: [UPGRADE.ZONE, UPGRADE.SALVO, UPGRADE.VELOCITY],
    // Sphere verte, la plus grosse du catalogue : l'arme la plus forte et la
    // plus lente doit se voir partir. Vert franc face a l'ambre de
    // l'eventail — les deux armes de Braise ne se ressemblent pas.
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
    // ⚠️ **ETAPE 12 : trois lames en ORBITE autour du joueur** (`motion:
    // 'orbite'`, `ORBIT_RADIUS`), jamais consommees, qui retouchent un meme
    // ennemi apres `REHIT_TICKS`. Une couronne de protection, la seule arme
    // qui ne part pas devant. Vie = cadence (40 ticks) : la couronne suivante
    // nait quand la precedente s'eteint. Le tour complet (`spreadRadians`)
    // repartit les lames a 120° ; `projectileSpeed` n'entre plus dans leur
    // course (elles tournent a `ORBIT_TURNS_PER_S`), il reste pour les regles
    // du catalogue. Un ennemi sur le cercle prend 3 x 0,9 = 2,7 passages par
    // seconde : 6 degats y font 16 /s, contre 17 /s avant sur une cible.
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
    // Le givre « rapide », en face de l'eventail : trois projectiles par
    // seconde, de quoi entretenir des marques de Givre sur un front que la
    // Braise d'un allie viendra faire reagir (§6.2).
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
    // Salve tres large a courte portee : l'autre extreme de la dispersion,
    // face a `eventail`.
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
    // Arme a projectile unique et longue portee. Elle a un temps ete la seule
    // du catalogue a « evoluer » ; les evolutions n'existent plus (§9.1 de la
    // spec), elle s'empile comme les autres.
    //
    // ⚠️ **LE FAISCEAU** (etape 8) — la troisieme famille, apres l'anneau et le
    // halo. Il ne pose aucun projectile : a chaque recharge, il fauche TOUT ce
    // qui se tient sur le trait, du joueur jusqu'au bout de sa portee.
    //
    // ⚠️ **Il REMPLACE le Sceptre arcanique**, le givre « de placement » : un
    // trait qui part du joueur et traverse la ligne EST un placement, en plus
    // franc. Le Givre garde ses deux armes avec les fleches-jumelles, et le
    // catalogue reste a dix-sept.
    //
    // ⚠️ **Le balayage est celui des PROJECTILES** : `distanceToSegmentSquared`
    // (`shared/projectiles.ts`), ecrit pour que `collide` teste le segment
    // parcouru pendant un pas plutot que son seul point d'arrivee. Un faisceau
    // est ce meme segment, mais tenu une image au lieu d'un tick — aucune
    // geometrie nouvelle.
    //
    // ⚠️ **`projectileSpeed` et `projectileLifeTicks` ne sont PAS inertes ici**,
    // contrairement au halo : leur produit donne la LONGUEUR du trait, la meme
    // derivation que la portee de toutes les autres armes (voir `beamRange`).
    // Seul `blastRadius` change de sens — il devient la demi-largeur.
    name: 'Rayon arcanique',
    perks: [UPGRADE.ZONE, UPGRADE.RANGE],
    kind: 'faisceau',
    /** La demi-largeur du trait : ce qui est a moins de 18 px du rayon est fauche. */
    blastRadius: 18,
    // Eclat turquoise a fort halo : c'est la teinte que le TRAIT prend a
    // l'ecran (voir le miroir cosmetique dans `GameClient`), donc elle reste
    // ce qui identifie l'arme — la forme, elle, ne sert plus a rien ici.
    look: {
      shape: 'eclat',
      diameterPx: 20,
      tint: 0x28e6d0,
      glow: 0.6,
      trailTicks: 1.5,
      spinTurns: 1.6,
      trail: 'etincelles',
    },
    cooldownTicks: 24,
    damage: 10,
    projectileSpeed: 480,
    projectileLifeTicks: 30,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.GIVRE,
  },
  {
    // Tache 9 de l'etape 5b : la Foudre a enfin ses armes.
    //
    // La foudre « rapide », en face de fleches-jumelles et de l'eventail :
    // deux projectiles par salve, cadence courte. Chaque impact chaine
    // (`ELEMENT.FOUDRE` declenche `chainTargets` dans `resolveProjectileDamage`,
    // back/src/combat.ts) — une arme qui touche souvent seme donc des chaines
    // souvent, la ou une arme lente laisserait l'effet signature de l'element
    // se voir a peine.
    name: 'Bobine Tesla',
    perks: [UPGRADE.SALVO, UPGRADE.RANGE, UPGRADE.HOMING],
    // Zigzag lavande a fort halo, trainee courte criblee d'etincelles, et il
    // scintille a contresens des autres (rotation NEGATIVE) : un arc qui
    // crepite plutot qu'un trait qui file — le mot etait deja dans ce
    // commentaire avant que la forme ne le dise (etape 8). Distincte de la
    // teinte de l'element (0xf3e94b, jaune) comme l'exige `assertWeaponLooks`.
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
    // La foudre « lourde », en face du sceptre-arcanique et de l'arc-lourd :
    // projectile unique, cadence lente, degats eleves. Le premier maillon
    // d'une chaine doit peser pour que la reaction Court-circuit (Foudre +
    // Poix, `shared/reactions.ts`) parte d'un coup qui compte, pas d'une
    // piqure.
    //
    // ⚠️ **ETAPE 12 : une FRAPPE, plus un projectile** (`kind: 'frappe'`,
    // `shared/onde-frappe.ts`). Au tir, le point vise a portee (600 x 24 / 30
    // = 480 px, 750 avant) ; ses trois ennemis les plus proches recoivent
    // chacun un eclair `FRAPPE_DELAY_TICKS` plus tard, une pulsation de rayon
    // `blastRadius`. `projectileCount` compte les eclairs (SALVO en ajoute
    // un), `projectileSpeed x projectileLifeTicks` donne la portee (RANGE).
    // Trois cibles au lieu d'une : 12 degats par eclair, soit 11 /s par cible
    // (14,5 avant) et 33 /s sur un groupe.
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
    // Le rayon de chaque eclair — le souffle de contact de l'etape 8, voir
    // `HEAVY_BLAST_RADIUS`.
    blastRadius: HEAVY_BLAST_RADIUS,
  },
  {
    // La poix « rapide » : plusieurs projectiles a courte portee, pour
    // etaler la marque sur un front — c'est `ZoneField.ampAt` (`shared/zones.ts`)
    // qui lit `damageAmp`, donc plus de zones posees par la reaction est plus
    // d'occasions pour un allie de frapper dans une flaque amplifiee.
    // ⚠️ **LE HALO** (etape 8) — *« ca peut etre un halo qui empoisonne »*. Il
    // ne tire RIEN : a chaque recharge, il frappe tout ce qui se tient dans
    // son rayon, autour du joueur.
    //
    // ⚠️ **Il REMPLACE la Seringue a poix**, la poix « rapide » qui etalait sa
    // marque en trois gouttes : un halo fait la meme chose — etaler la marque
    // sur un front — en disant mieux ce que la Poix EST. Le catalogue reste a
    // dix-sept armes (*« on peut supprimer certaines armes pour eviter d'avoir
    // un pool trop eleve »*), et la Poix garde ses deux armes avec le Chaudron.
    //
    // ⚠️ **Le balayage est celui de la GRENADE**, `damageInRadius`, ecrit a la
    // tache 16 et deja partage avec la reaction elementaire : un halo est une
    // explosion qui se repete sur le joueur, pas un systeme de plus.
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
      // ⚠️ **Ambre VIF, et plus un brun sourd** (*« on voit mal le halo »*) :
      // la teinte d'une arme de halo n'habille pas un projectile de dix
      // pixels, elle EST le disque qu'on voit battre autour du joueur.
      // 0x8a6d3f se perdait sur l'herbe — le meme defaut que celui corrige
      // pour les armes de Chaux et de Vif-argent, qui attendait ici le jour ou
      // une teinte se mettrait a porter une surface plutot qu'un point.
      tint: 0xe0a53c,
      glow: 0.2,
      trailTicks: 0.8,
      spinTurns: 0.8,
      trail: 'fumee',
    },
    // ⚠️ **12 ticks, et c'est un reglage de LISIBILITE** (*« on voit mal le
    // halo »*) : une pulsation dure ce que dure son flash, 220 ms, et une
    // recharge de 18 ticks (600 ms) laissait donc l'aura eteinte les deux
    // tiers du temps. A 12 ticks (400 ms) elle bat presque sans interruption,
    // et la puissance ne bouge pas — 5 degats toutes les 18 ticks font 8,3 par
    // seconde, 4 toutes les 12 en font 10.
    cooldownTicks: 12,
    damage: 4,
    projectileSpeed: 480,
    projectileLifeTicks: 18,
    projectileCount: 1,
    spreadRadians: 0.4,
    element: ELEMENT.POIX,
  },
  {
    // La poix « lourde » : projectile unique, cadence lente, degats eleves —
    // en face de la grenade et du canon-a-arc. Elle vise a poisser une cible
    // choisie plutot qu'a arroser, le pendant exact de la seringue.
    //
    // ⚠️ **ETAPE 12 : un MORTIER** (`motion: 'mortier'`). Il vole au-dessus de
    // la horde sans toucher personne (`collide` l'ignore) et saute en fin de
    // course, a 400 px, par le souffle de fin de course : on ne vise plus une
    // cible, on vise un POINT. Le rendu le monte en cloche
    // (`MORTAR_APEX_PX`) au-dessus de son ombre. Chiffres inchanges.
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
    // Souffle de contact (etape 8) : voir `HEAVY_BLAST_RADIUS`. Le seul coup
    // du mortier, depuis l'etape 12.
    blastRadius: HEAVY_BLAST_RADIUS,
    motion: 'mortier',
  },
  {
    // Tache 8 de l'etape 5c : la Chaux a enfin ses armes.
    //
    // ⚠️ **LA MINE** (etape 8) — la quatrieme famille, apres l'anneau, le halo
    // et le faisceau.
    //
    // ⚠️ **Elle n'a demande AUCUN type d'arme de plus, comme l'anneau.** Un
    // projectile IMMOBILE a souffle EST une mine, et les trois pieces
    // existaient deja :
    //
    // | Ce qu'il faut a une mine | Ce que la donnee dit deja |
    // | --- | --- |
    // | rester ou on la pose | `projectileSpeed: 0` |
    // | attendre longtemps | `projectileLifeTicks` — ici 8 secondes |
    // | sauter quand on s'approche | `collide` teste `PROJECTILE_HIT_RADIUS` autour d'elle : c'est deja un detecteur de proximite |
    // | emporter le voisinage | `blastRadius`, l'arme de zone de la tache 16 |
    //
    // ⚠️ **Elle REMPLACE la Poire a chaux**, la chaux « rapide » qui etalait sa
    // marque en trois bouffees courtes. La Chaux garde ses deux armes avec le
    // Canon, et le catalogue reste a dix-sept.
    //
    // ⚠️ **Elle se pose AUX PIEDS du joueur**, pas devant : `#emit` depose a la
    // position du tireur, et a vitesse nulle la direction visee n'a plus
    // d'effet. C'est une arme qui demande de faire passer la horde SUR soi
    // puis de s'ecarter — l'inverse exact du faisceau, qui demande de l'aligner
    // devant.
    //
    // ponytail: empiler cette arme pose N mines AU MEME POINT (toutes les
    // salves partent de la meme position a vitesse nulle), donc les
    // exemplaires concentrent les degats au lieu de couvrir plus de terrain.
    // Acceptable — ca reste « l'accumulation fait la puissance » —, mais si
    // l'auteur veut un semis, il faudra un deport a l'emission, pas une regle
    // de plus ici.
    name: 'Semoir de chaux',
    perks: [UPGRADE.ZONE, UPGRADE.RANGE, UPGRADE.VENOM],
    // ⚠️ **`blastRadius` est ce que la mine emporte en sautant** — le sens
    // ordinaire du champ (la grenade l'a depuis la tache 16), pas le sens
    // detourne du halo et du faisceau.
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
    // La chaux « lourde », en face du chaudron-a-poix et du canon-a-arc :
    // projectile unique, cadence lente, degats eleves. Le premier ennemi
    // touche doit deja fuir avant qu'un allie n'ait besoin de suivre.
    //
    // ⚠️ **ETAPE 12 : une ONDE, plus un obus** (`kind: 'onde'`,
    // `shared/onde-frappe.ts`). Un anneau de chaux part du joueur a
    // `projectileSpeed` (460 px/s) jusqu'a `blastRadius` (220 px, que ZONE
    // agrandit) et frappe une fois chaque ennemi qu'il franchit. Il touche
    // TOUT un cercle au lieu d'une cible : la cadence passe de 38 a 44 ticks
    // (10 /s par ennemi franchi, 11,8 avant sur une cible). Plus de SALVO ni
    // de CALIBRE : il n'y a plus de projectile a multiplier ou grossir.
    name: 'Canon à chaux',
    perks: [UPGRADE.ZONE],
    kind: 'onde',
    // Os-et-ocre, la plus sourde des deux armes de Chaux sans etre sombre
    // (etape 8 : 0x4f7a1a, un olive fonce, se perdait dans l'herbe) : c'est
    // la teinte de l'anneau, distincte de celle de l'element.
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
    // Tache 8 de l'etape 5c : le Vif-argent a enfin ses armes.
    //
    // ⚠️ **L'INVOCATION** (etape 8) — la cinquieme et derniere famille :
    // *« ca peut etre des adds qui tapent et te protegent »*.
    //
    // ⚠️ **Elle REUTILISE le halo, en le DETACHANT du joueur.** Une invocation
    // pose un corps immobile qui frappe autour de lui : c'est exactement une
    // pulsation de halo, a ceci pres que son centre reste ou on l'a posee au
    // lieu de suivre le porteur. `resolveHalos` les resout donc toutes les
    // deux, sans une ligne de plus — voir `Guard` et `guardPulsesAt`.
    //
    // ⚠️ **Rien ne transite.** Une invocation est entierement determinee par
    // l'arme, le tick et la position du tireur, comme un tir (§5.2) : les deux
    // cotes la derivent, aucun octet ne part sur le fil.
    //
    // ⚠️ **Elle ne DETOURNE PAS la horde, et c'est une limite assumee.** Le
    // « te protege » du brief demanderait de la verser dans le champ de flux,
    // comme `substituteDecoys` le fait pour le leurre d'Appat — et ce champ est
    // la seule chose que les deux cotes derivent au pixel pres, a partir de
    // positions RETARDEES, precisement pour ne jamais diverger. Une invocation
    // posee depuis une position predite cote client et arbitree cote serveur y
    // entrerait a deux endroits legerement differents, et toute la horde s'en
    // irait ailleurs. Elle protege donc en TUANT ce qui approche, pas en
    // detournant — et si l'auteur veut le leurre, c'est une tache a part, pas
    // une ligne de plus ici.
    //
    // ⚠️ **Elle REMPLACE la Fronde a mercure**, le vif-argent « rapide » :
    // `linkedNeighbours` (`shared/links.ts`) se derive d'une PAIRE de
    // positions, donc une invocation qui frappe deux fois par seconde au
    // milieu de la horde pose encore plus souvent l'occasion qu'une liaison
    // s'etablisse. Le Vif-argent garde ses deux armes avec le Glaive, et le
    // catalogue reste a dix-sept.
    name: 'Homoncule de mercure',
    perks: [UPGRADE.ZONE, UPGRADE.RANGE],
    kind: 'invocation',
    // Le rayon de chaque pulsation — `blastRadius` au sens du halo : ce qui
    // decide de ce qui meurt.
    blastRadius: 90,
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
    // Trois secondes entre deux poses, cinq secondes de vie : deux homoncules
    // se chevauchent donc toujours un peu, et l'arme ne connait jamais de
    // silence complet.
    cooldownTicks: 90,
    damage: 6,
    // Elle ne LANCE rien — meme regle que la mine, voir `MIN_MUZZLE_SPEED`.
    projectileSpeed: 0,
    /** La duree de vie de l'invocation, pas celle d'un projectile. */
    projectileLifeTicks: 150,
    projectileCount: 1,
    spreadRadians: 0.18,
    element: ELEMENT.VIF_ARGENT,
  },
  {
    // Le vif-argent « lourd », en face du canon-a-chaux et du chaudron-a-poix :
    // projectile unique, cadence lente, degats eleves. Le premier maillon
    // d'une liaison doit peser pour que l'allie qui la retrouve trouve deux
    // ennemis deja groupes.
    //
    // ⚠️ **ETAPE 12 : un BOOMERANG** (`motion: 'boomerang'`). Il part dans la
    // visee en ralentissant jusqu'a l'arret a mi-vie, puis revient vers son
    // tireur a pleine vitesse ; jamais consomme, il touche a l'aller ET au
    // retour (`REHIT_TICKS`). Pour aller assez loin malgre le freinage, plus
    // vif et plus long : 600 px/s, 50 ticks, ~250 px a l'aller. Plus de
    // souffle (voir `HEAVY_BLAST_RADIUS`) ni de PIERCE (il traverse tout) :
    // 12 degats, soit 11 /s par passage et 22 /s sur un ennemi qu'il croise
    // deux fois (13 /s et un souffle avant).
    name: 'Glaive de mercure',
    perks: [UPGRADE.SALVO, UPGRADE.CALIBRE, UPGRADE.RANGE],
    // Lame a garde lilas argente qui tourne sur elle-meme, fort halo : le
    // mercure se voit partir, contrairement a la poix qui n'illumine rien.
    // Eclaircie a l'etape 8 (0x45456e, une ardoise sombre, etait invisible sur
    // l'herbe) tout en restant plus sourde que le dard de la fronde.
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
    // ⚠️ **ETAPE 12 : il ONDULE** (`motion: 'sinus'`, `SINUS_AMPLITUDE` px de
    // part et d'autre de sa ligne). Les ricochets restent : la ligne repart
    // de chaque impact. Chiffres inchanges.
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
    // ⚠️ **ETAPE 12 : un ESSAIM.** Cinq mini-missiles en eventail (1,6 rad)
    // qui se rabattent (guidage 5 -> 9 rad/s) au lieu d'un seul : il ne
    // ressemblait plus qu'a une grenade d'une autre teinte. Plus de souffle —
    // il reste aux armes a projectile unique, voir `HEAVY_BLAST_RADIUS` — ni
    // de ZONE. 5 degats par missile : 18 /s si les cinq trouvent la meme
    // cible, contre 13 /s et un souffle avant.
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
 * Verifie que chaque apparence se distingue de toutes les autres, et
 * qu'aucune ne se fait passer pour son element.
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
 *    « chaque arme a une apparence » et « toutes les armes ont la MEME
 *    apparence » se ressemblent beaucoup.
 *
 * ⚠️ **Rien sur la FORME.** Exiger des formes deux a deux distinctes
 * interdirait a une arme suivante d'en reutiliser une, donc ferait de
 * « ajouter une arme » de l'architecture. Le catalogue compte neuf formes
 * (`ProjectileShape`) pour dix-sept armes depuis la tache 8 de l'etape 5c
 * (Chaux et Vif-argent reutilisent des formes deja prises par les elements
 * precedents, comme Foudre et Poix l'avaient fait a la tache 9 de l'etape
 * 5b) — c'est la TEINTE qui distingue, jamais la forme, exactement ce que
 * cette garde verifie et pas davantage.
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
 * 40 etait la duree de vie de l'arc-lourd (50 depuis l'etape 12), la plus
 * longue portee reelle du catalogue — `weapons.test.ts` verifie qu'il
 * l'atteint plutot que de le laisser en commentaire. Une arme qui l'atteint « file net » : son fondu vaut
 * exactement zero.
 */
export const PROJECTILE_FADE_REFERENCE_TICKS = 40;

/**
 * Vitesse MINIMALE d'un projectile, derivee de celle du joueur.
 *
 * ⚠️ **Un projectile doit prendre de l'avance sur le joueur qui le suit,
 * sinon il lui reste colle** — signale deux fois en jouant : *« quand on
 * avance dans la meme direction, les tirs sont sur moi »*, puis *« les
 * projectiles se tassent encore »*. `PLAYER_SPEED` vaut 260 : a 350 (l'ancienne
 * grenade) la vitesse RELATIVE n'etait que de 90 px/s, soit trois dixiemes de
 * seconde pour sortir d'un corps de 32 px de rayon. Six armes sur dix-sept
 * etaient dans ce cas.
 *
 * 200 px/s d'avance, c'est un corps de joueur franchi en un sixieme de
 * seconde. `weapons.test.ts` garde le plancher pour toutes les armes, donc une
 * arme lente ajoutee au catalogue se fera refuser plutot que de se tasser.
 *
 * ⚠️ **La PORTEE de chaque arme touchee a ete preservee** (`projectileSpeed x
 * projectileLifeTicks / TICK_HZ`), a quelques pixels d'arrondi pres : ce tour
 * corrige une sensation, il ne rallonge aucune arme.
 *
 * ⚠️ **L'autre remede — faire HERITER au projectile la vitesse du tireur — a
 * ete ecarte, et ce n'est pas par paresse.** Le §5.2 tient a ce qu'un tir soit
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
 * compare. Il descendra dans `Weapon` le jour ou deux invocations devront
 * frapper a des rythmes differents.
 *
 * 15 : deux fois par seconde a `TICK_HZ`. Assez pour qu'on la voie travailler,
 * assez lent pour qu'on compte ses coups.
 */
export const GUARD_PULSE_TICKS = 15;

/**
 * Une invocation posee : un corps immobile qui frappe autour de lui jusqu'a
 * s'eteindre (etape 8).
 *
 * ⚠️ **Elle vit dans `shared/` parce que les DEUX cotes la derivent.** Le
 * serveur en tire des degats, le client le dessin qui les accompagne — et ni
 * l'un ni l'autre n'annonce quoi que ce soit : une invocation est entierement
 * determinee par l'arme, le tick et la position du tireur, exactement comme un
 * tir (§5.2). Zero octet de plus sur le fil.
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
  /** Le joueur qui l'a posee : c'est LUI que la marque retient, donc lui que la Synergie compare (§7). */
  readonly by: number;
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
 * qui decrivent la meme chose finissent par se contredire — ce depot l'a
 * rencontre trois fois. Le fondu occupe la part `1 - lifeTicks / REFERENCE` de
 * la vie du projectile : plus la portee est courte, plus tot il commence.
 *
 * | Arme | `projectileLifeTicks` | part de vie en fondu |
 * | --- | --- | --- |
 * | canon-a-mitraille | 8 | 80 % |
 * | **lance-flammes** | **12** | **70 %** (10 ticks / 75 % avant l'etape 8) |
 * | eventail | 12 | 70 % |
 * | dague | 28 | 30 % |
 * | chakram | 35 | 12,5 % |
 * | **arc-lourd** | **50** (40 avant l'etape 12) | **0 % — il file net** |
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
 * base, voir sa doc —, repartis sur le meme `spreadRadians`. C'est le levier le plus lisible
 * a l'ecran dans un bullet heaven — on VOIT sa salve s'elargir — la ou une
 * reduction de recharge se devine et ou les degats ne modulent aujourd'hui
 * aucune issue (la pietaille n'a pas de reserve de points de vie).
 *
 * `stacks` a zero rend le compte de base : l'arme neutre, qui n'est jamais
 * empilee, passe par le meme chemin sans cas particulier.
 */
export function salvoCount(weapon: Weapon, stacks: number): number {
  return weapon.projectileCount + Math.max(0, stacks - 1) * stackGain(weapon);
}

/**
 * Projectiles qu'UN exemplaire supplementaire ajoute a la salve — un par
 * tranche de trois dans la salve de base, jamais moins d'un.
 *
 * ⚠️ **Mesure, etape 8.** Jusqu'ici chaque carte ajoutait UN projectile, quelle
 * que soit la salve de base, et c'est une regle qui PUNIT les armes larges : a
 * quatre exemplaires, une arme a projectile unique quadruplait ses degats
 * (×4,0) quand l'eventail gagnait 60 % (×1,6) et le canon-a-mitraille 37 %
 * (×1,4). L'eventail finissait DERNIER du catalogue a quatre cartes alors
 * qu'il en est neuvieme a une seule — le classement se retournait sur un
 * detail de formule, pas sur un choix de jeu.
 *
 * | Arme | salve de base | gain par carte | a 4 cartes, avant | apres |
 * | --- | --- | --- | --- | --- |
 * | arc-lourd, grenade, chakram… | 1 | 1 | ×4,0 | ×4,0 (inchange) |
 * | fleches-jumelles, Tesla, fronde | 2 | 1 | ×2,5 | ×2,5 (inchange) |
 * | lance-flammes, seringue, poire | 3 | 1 | ×2,0 | ×2,0 (inchange) |
 * | **eventail** | 5 | **2** | ×1,6 | **×2,2** |
 * | **canon-a-mitraille** | 8 | **3** | ×1,4 | **×2,1** |
 *
 * ⚠️ **Deux armes seulement changent**, et ce sont exactement les deux que la
 * formule penalisait. Treize des dix-sept ont une salve de base de 1 a 3 et
 * gardent leur gain d'un projectile : ce n'est pas une inflation du catalogue,
 * c'est la correction d'un biais.
 *
 * ⚠️ **Le budget de `PROJECTILE_CAPACITY` a ete mesure avec l'ancienne
 * regle** : une arme large y tient desormais moins d'exemplaires qu'avant (le
 * canon-a-mitraille entretient trois fois plus de projectiles par carte). La
 * capacite n'est qu'un plafond memoire et `truncatedProjectiles` compte ce qui
 * deborde — mais le banc qui a fixe 2048 reste a relancer pour le confirmer.
 */
/**
 * De combien le rayon d'effet d'une arme SANS projectile grandit par
 * exemplaire empile, en fraction.
 *
 * ⚠️ **C'est l'equivalent de `salvoCount` pour les armes qui ne tirent pas.**
 * « L'accumulation des cartes fait la puissance » (§7.2) doit valoir pour
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
 * reglage — ce depot l'a deja paye trois fois sur des valeurs dupliquees.
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
