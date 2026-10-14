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
   * ⚠️ **Les dix-sept calibres ont ete multiplies par 1,4 a l'etape 8**, en
   * gardant leur ORDRE et leur distinction deux a deux (de 7 a 29 px, contre 5
   * a 21). La raison est mesuree, pas esthetique : une case d'atlas dessine la
   * silhouette sur 32 px, et a 5 ou 10 px a l'ecran il ne restait rien a lire
   * de ce que la forme disait — constate sur une planche des dix-sept
   * silhouettes rendue a 128 px, ou les defauts de `masse` et `bouffee` se
   * voyaient alors qu'en jeu ils passaient inapercus.
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

export interface Weapon {
  id: number;
  name: string;
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
 * percute ». Cinq armes sur dix-sept sont neutres et le restent — *« un socle pour
 * les joueurs qui ne veulent pas jouer le systeme »* (§6.3 de l'orientation) —
 * et une seule explose : dans les deux cas c'est la ligne ABSENTE qui est le
 * cas courant, et l'exception se lit d'un coup d'oeil.
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
 * | lance-flammes | 5 | **3** | ×0,60 | la plus rapide du catalogue, et elle le reste ; on ne descend pas a 2, ou le passif mourrait en quatre cartes |
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
    name: 'Dague',
    // Lame d'acier, etroite et sobre : l'arme que tout le monde porte ne doit
    // jamais voler la vedette aux huit autres, d'ou le blanc bleute et le halo
    // le plus discret du catalogue.
    look: {
      shape: 'lame',
      diameterPx: 14,
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
    // Plusieurs projectiles en eventail : prouve que la dispersion tient,
    // pas seulement le tir a projectile unique.
    //
    // La braise « large » : cinq projectiles etales sur 60°, donc un front de
    // marques sur toute une vague. Chaque element a besoin d'une arme qui
    // arrose et d'une qui frappe fort — un element qu'on n'applique presque
    // jamais est un systeme qu'on ne sent pas.
    name: 'Éventail',
    // Petale ambre. ⚠️ **Ambre, pas orange de Braise** (0xff7a3c) : c'est la
    // zone au sol qui dit l'element, pas le projectile — et la grenade, Braise
    // elle aussi, part sur un vert franc pour qu'on ne confonde jamais les
    // deux (voir `assertWeaponLooks`).
    look: {
      shape: 'petale',
      diameterPx: 15,
      tint: 0xffc23d,
      glow: 0.45,
      trailTicks: 1,
      spinTurns: 0.5,
      trail: 'fumee',
    },
    cooldownTicks: 27,
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
    name: 'Arc lourd',
    // Le trait le plus gros, le plus rapide et le plus long du catalogue — et
    // le seul qui ne s'eteint JAMAIS en vol : sa vie (40 ticks) atteint
    // `PROJECTILE_FADE_REFERENCE_TICKS`, donc `projectileAlpha` le laisse a
    // pleine opacite jusqu'au bout. « Il file net », par derivation.
    look: {
      shape: 'fleche',
      diameterPx: 24,
      tint: 0x9a5cff,
      glow: 0.25,
      trailTicks: 1.6,
      spinTurns: 0,
      trail: 'lisse',
    },
    cooldownTicks: 36,
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
    name: 'Lance-flammes',
    // ⚠️ **Le cas que la tache 12 nomme** : 10 ticks de vie, donc le fondu le
    // plus long du catalogue (`projectileAlpha` en tire 75 % de sa vie). La
    // langue de feu s'eteint en vol au lieu de disparaitre d'un coup a bout de
    // portee — c'est ce que l'auteur voyait manquer en jouant. Halo le plus
    // fort, trainee la plus courte : tout se passe au contact.
    look: {
      shape: 'flamme',
      diameterPx: 18,
      tint: 0xff4d2e,
      glow: 0.7,
      trailTicks: 1,
      spinTurns: 0,
      trail: 'fumee',
    },
    cooldownTicks: 3,
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
    name: 'Grenade',
    // Sphere verte, la plus grosse du catalogue : une arme a 40 degats et 75
    // ticks de recharge doit se voir partir. Vert franc face a l'ambre de
    // l'eventail — les deux armes de Braise ne se ressemblent pas.
    look: {
      shape: 'sphere',
      diameterPx: 25,
      tint: 0x39d97a,
      glow: 0.55,
      trailTicks: 1.5,
      spinTurns: 1.2,
      trail: 'fumee',
    },
    cooldownTicks: 45,
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
    name: 'Chakram',
    // Anneau magenta : la seule forme creuse du catalogue, pour une arme dont
    // le nom EST un disque perce.
    look: {
      shape: 'anneau',
      diameterPx: 20,
      tint: 0xff45c8,
      glow: 0.35,
      trailTicks: 1.5,
      spinTurns: 3.5,
      trail: 'lisse',
    },
    cooldownTicks: 21,
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
    name: 'Flèches jumelles',
    // Aiguille outremer, la plus fine du catalogue : deux traits paralleles
    // doivent se lire comme deux traits, pas comme une tache. Outremer face au
    // turquoise du sceptre — les deux armes de Givre ne se ressemblent pas, et
    // ni l'une ni l'autre ne porte le bleu de l'element (0x7ad8ff).
    look: {
      shape: 'aiguille',
      diameterPx: 13,
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
    // Grain citron, le plus petit du catalogue et la plus courte trainee (un
    // demi-tick) : huit projectiles a la fois, chacun doit rester un grain.
    look: {
      shape: 'grain',
      diameterPx: 10,
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
    // Le givre « de placement » : projectile unique, longue portee, cadence
    // moyenne — une zone posee ou on la vise, en face des fleches-jumelles.
    name: 'Sceptre arcanique',
    // Eclat turquoise a fort halo : l'arme « de placement » du Givre se vise,
    // donc elle se suit des yeux.
    look: {
      shape: 'eclat',
      diameterPx: 17,
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
    // Zigzag lavande a fort halo, trainee courte criblee d'etincelles, et il
    // scintille a contresens des autres (rotation NEGATIVE) : un arc qui
    // crepite plutot qu'un trait qui file — le mot etait deja dans ce
    // commentaire avant que la forme ne le dise (etape 8). Distincte de la
    // teinte de l'element (0xf3e94b, jaune) comme l'exige `assertWeaponLooks`.
    look: {
      shape: 'arc',
      diameterPx: 8,
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
    name: 'Canon à arc',
    // Javelot cyan electrique, la plus longue trainee des deux armes de
    // Foudre, criblee d'etincelles : elle se vise, donc elle se suit des yeux
    // comme le sceptre. Elle ne tourne pas — une hampe qui tourne ne perce
    // plus.
    look: {
      shape: 'javelot',
      diameterPx: 21,
      tint: 0x00e5ff,
      glow: 0.5,
      trailTicks: 1.4,
      spinTurns: 0,
      trail: 'etincelles',
    },
    cooldownTicks: 33,
    damage: 16,
    projectileSpeed: 750,
    projectileLifeTicks: 30,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.FOUDRE,
  },
  {
    // La poix « rapide » : plusieurs projectiles a courte portee, pour
    // etaler la marque sur un front — c'est `ZoneField.ampAt` (`shared/zones.ts`)
    // qui lit `damageAmp`, donc plus de zones posees par la reaction est plus
    // d'occasions pour un allie de frapper dans une flaque amplifiee.
    name: 'Seringue à poix',
    // Goutte ambre-brun, halo faible, trainee en tirets : la poix ne brille
    // pas, elle englue — et elle part par paquets, jamais en trait continu.
    // Distincte de la teinte de l'element (0x3d2b1f, brun fonce).
    look: {
      shape: 'goutte',
      diameterPx: 11,
      tint: 0x8a6d3f,
      glow: 0.2,
      trailTicks: 0.8,
      spinTurns: 0.8,
      trail: 'tirets',
    },
    cooldownTicks: 18,
    damage: 5,
    projectileSpeed: 480,
    projectileLifeTicks: 18,
    projectileCount: 3,
    spreadRadians: 0.4,
    element: ELEMENT.POIX,
  },
  {
    // La poix « lourde » : projectile unique, cadence lente, degats eleves —
    // en face de la grenade et du canon-a-arc. Elle vise a poisser une cible
    // choisie plutot qu'a arroser, le pendant exact de la seringue.
    name: 'Chaudron à poix',
    // Masse brun fonce, la plus terne du catalogue : une motte informe qui
    // roule sur elle-meme en fumant, sans halo marque, conforme a une arme
    // qui n'illumine rien.
    look: {
      shape: 'masse',
      diameterPx: 22,
      tint: 0x5c3a21,
      glow: 0.15,
      trailTicks: 1.3,
      spinTurns: -1,
      trail: 'fumee',
    },
    cooldownTicks: 40,
    damage: 14,
    projectileSpeed: 380,
    projectileLifeTicks: 32,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.POIX,
  },
  {
    // Tache 8 de l'etape 5c : la Chaux a enfin ses armes.
    //
    // La chaux « rapide », en face de la seringue-a-poix et des
    // fleches-jumelles : trois projectiles a courte portee, pour etaler la
    // marque sur un front. `armorReduction` et `fieldSign` (`shared/elements.ts`)
    // se lisent a la ZONE que la reaction laisse au sol, jamais au projectile
    // — donc une arme qui touche souvent seme donc plus souvent l'occasion
    // qu'une zone de Chaux se pose.
    name: 'Poire à chaux',
    // Bouffee vert vif — trois lobes de poudre, pas un grain —, distincte du
    // vert-jaune de l'element (0xb4d94a) : la zone au sol dit l'element, pas
    // le projectile (`assertWeaponLooks`).
    look: {
      shape: 'bouffee',
      diameterPx: 27,
      tint: 0x8fe34c,
      glow: 0.35,
      trailTicks: 0.9,
      spinTurns: 0.6,
      trail: 'fumee',
    },
    cooldownTicks: 17,
    damage: 4,
    projectileSpeed: 440,
    projectileLifeTicks: 16,
    projectileCount: 3,
    spreadRadians: 0.4,
    element: ELEMENT.CHAUX,
  },
  {
    // La chaux « lourde », en face du chaudron-a-poix et du canon-a-arc :
    // projectile unique, cadence lente, degats eleves. Le premier ennemi
    // touche doit deja fuir avant qu'un allie n'ait besoin de suivre.
    name: 'Canon à chaux',
    // Obus olive fonce, la plus terne des deux armes de Chaux : une capsule
    // qui ne tourne pas, distincte de la teinte de l'element et de celle de
    // la poire-a-chaux.
    look: {
      shape: 'obus',
      diameterPx: 29,
      tint: 0x4f7a1a,
      glow: 0.2,
      trailTicks: 1.2,
      spinTurns: 0,
      trail: 'fumee',
    },
    cooldownTicks: 38,
    damage: 15,
    projectileSpeed: 400,
    projectileLifeTicks: 34,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.CHAUX,
  },
  {
    // Tache 8 de l'etape 5c : le Vif-argent a enfin ses armes.
    //
    // Le vif-argent « rapide », en face des fleches-jumelles et de la
    // poire-a-chaux : deux aiguilles a cadence courte. `linkedNeighbours`
    // (`shared/links.ts`) se derive d'une PAIRE de positions et d'une zone
    // annoncee, jamais d'un champ porte par le projectile — une arme qui
    // touche souvent pose donc plus souvent l'occasion qu'une liaison
    // s'etablisse entre deux ennemis proches.
    name: 'Fronde à mercure',
    // Dard gris-mauve, le plus fin du catalogue : distinct de l'outremer des
    // fleches-jumelles et de la teinte de l'element (0xc9c9e8).
    look: {
      shape: 'dard',
      diameterPx: 7,
      tint: 0x7a7aa8,
      glow: 0.3,
      trailTicks: 1.1,
      spinTurns: 0,
      trail: 'lisse',
    },
    cooldownTicks: 14,
    damage: 6,
    projectileSpeed: 620,
    projectileLifeTicks: 22,
    projectileCount: 2,
    spreadRadians: 0.18,
    element: ELEMENT.VIF_ARGENT,
  },
  {
    // Le vif-argent « lourd », en face du canon-a-chaux et du chaudron-a-poix :
    // projectile unique, cadence lente, degats eleves. Le premier maillon
    // d'une liaison doit peser pour que l'allie qui la retrouve trouve deux
    // ennemis deja groupes.
    name: 'Glaive de mercure',
    // Lame a garde gris fonce qui tourne sur elle-meme, fort halo : le mercure
    // se voit partir, contrairement a la poix qui n'illumine rien.
    look: {
      shape: 'glaive',
      diameterPx: 28,
      tint: 0x45456e,
      glow: 0.5,
      trailTicks: 1.3,
      spinTurns: 2.6,
      trail: 'lisse',
    },
    cooldownTicks: 32,
    damage: 14,
    projectileSpeed: 460,
    projectileLifeTicks: 30,
    projectileCount: 1,
    spreadRadians: 0.05,
    element: ELEMENT.VIF_ARGENT,
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
