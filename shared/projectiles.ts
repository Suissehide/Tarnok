import { ARCHETYPES } from './archetypes';
import { PROJECTILE_HIT_RADIUS, VIF_ARGENT_HIT_RADIUS_BONUS } from './constants';
import type { Horde } from './horde';
import type { Weapon } from './weapons';
import type { ZoneField } from './zones';

/**
 * Les projectiles : simules localement, jamais repliques (§5.2 de la spec).
 *
 * Un tir est entierement determine par des donnees que serveur et clients
 * possedent deja — l'arme, le tick, la position du tireur, et (§5.3 revu par
 * la tache 13 : la visee suit le curseur, ce n'est plus une auto-visee sur la
 * horde) la direction visee, transmise sur un octet signe par `INPUT` et
 * `SNAPSHOT`. C'est ce SEUL octet qui transite ; la salve elle-meme (position,
 * vitesse, degats de chaque projectile) reste calculee identiquement des deux
 * cotes a partir de la meme direction quantifiee — voir `fireSalvoDirected` et
 * `quantizeAxis` dans `shared/protocol.ts`. Le test de derivation de ce
 * fichier verrouille cette propriete : deux instances independantes, memes
 * entrees, memes projectiles.
 *
 * ⚠️ **`Projectiles.collide` accepte `zones`/`tick` en optionnels depuis
 * l'etape 5c (tache 3), et ca ne rouvre PAS ce contrat.** Ils elargissent le
 * rayon de touche d'un ennemi en zone de Vif-argent — un effet de DEGAT, qui
 * decide QUI un projectile touche, jamais OU il va. La trajectoire
 * (`#emit`/`fireSalvoDirected`) reste aveugle a la horde et aux zones ; seule
 * `collide`, qui resout une collision DEJA CALCULEE, les consulte.
 *
 * Tableaux typés, jamais un objet par projectile (§4.4 de l'orientation) — a
 * plusieurs centaines de projectiles vivants, le meme raisonnement que pour
 * `Horde` s'applique. `x` et `y` sont publics en lecture, comme sur `Horde` :
 * le rendu (tache 11) les lit directement sans jamais materialiser d'objet.
 *
 * L'expiration se compte en **pas de simulation**, pas en tick absolu : un
 * compte a rebours par projectile, decremente une fois par appel a `step`.
 * Ca evite a cette classe de devoir tenir sa propre horloge synchronisee sur
 * celle de l'appelant — la seule hypothese est que `step` est appele
 * exactement une fois par tick, comme `Horde.step`.
 */
/**
 * Le rayon de touche AU CARRE de chaque archetype, et sa borne elargie — deux
 * tables cuites au chargement, indexees par `Horde.archetype`.
 *
 * ⚠️ **Le rayon de touche suit le CORPS, et c'est le defaut que l'etape 8
 * corrige.** `collide` testait un rayon unique de 32 px pour tout le monde,
 * alors que le boss est dessine a `BODY_SCALE x bodyScale` de ce rayon — soit
 * 240 px de diametre pour une cible de 64. Il fallait viser le centre d'un
 * corps douze fois plus large que la zone qui encaissait : en jeu, « la hitbox
 * du boss est trop petite ». `bodyScale` existait deja et disait exactement
 * ca — `BOSS_CHARGE_WIDTH_PX` et `spriteScale` le lisent tous les deux depuis
 * l'etape 6a ; seule la collision l'ignorait.
 *
 * ⚠️ **Des TABLES, pas un calcul dans la boucle.** La boucle interne de
 * `collide` est en projectiles x ennemis — 49 millions de tests de distance par
 * tick ont deja ete mesures ici (voir le pre-filtre du Vif-argent). Une lecture
 * de tableau type remplace exactement l'ancienne constante ; un
 * `archetypeOf(...).bodyScale` y aurait mis une recherche d'objet.
 */
const HIT_R2_BY_ARCHETYPE = Float32Array.from(ARCHETYPES, (a) => {
  const r = PROJECTILE_HIT_RADIUS * a.bodyScale;
  return r * r;
});

/** La meme table, majoree du bonus de Vif-argent : la borne du pre-filtre. */
const WIDE_R2_BY_ARCHETYPE = Float32Array.from(ARCHETYPES, (a) => {
  const r = PROJECTILE_HIT_RADIUS * a.bodyScale + VIF_ARGENT_HIT_RADIUS_BONUS;
  return r * r;
});

export class Projectiles {
  /** Position courante, publique en lecture pour le rendu — comme `Horde.x` / `Horde.y`. */
  readonly x: Float32Array;
  readonly y: Float32Array;
  /**
   * Tick de tir. Public en lecture : la tache 11 en aura besoin pour le
   * rendu (par exemple un fondu a l'apparition), et `#removeAt` doit le
   * compacter comme tout le reste — l'exposer permet de le verifier depuis
   * un test sans ajouter de code de test dans la classe.
   */
  readonly bornTick: Uint32Array;

  readonly #vx: Float32Array;
  readonly #vy: Float32Array;
  readonly #damage: Float32Array;
  /**
   * Element porte par le projectile, index dans `ELEMENTS` — recopie de
   * `Weapon.element` a l'emission (etape 5a, tache 6). `ELEMENT.NEUTRE` pour
   * les cinq armes neutres, qui ne marquent rien et ne posent aucune zone.
   */
  readonly #element: Uint8Array;
  /**
   * Index du joueur qui a tire — c'est LUI que la marque retient (`Horde.markBy`)
   * et que la zone porte (`ZoneField.by`), donc lui que la Synergie du §7
   * comparera. Sans ce tableau, une reaction entre deux joueurs et une
   * reaction en solo seraient indiscernables au moment de l'impact.
   */
  readonly #by: Uint8Array;
  /**
   * Rayon de l'explosion a l'impact, en pixels monde — recopie de
   * `Weapon.blastRadius` a l'emission (etape 6a, tache 16). `0` : ce
   * projectile ne touche que ce qu'il percute.
   *
   * ⚠️ **Recopie a cote, JAMAIS relu dans `WEAPONS` a l'impact** — la meme
   * raison que `#damage`, `#element` et `#by` juste au-dessus, et la raison
   * exacte pour laquelle `#weapon` peut rester purement cosmetique : ce qui
   * decide d'un degat ne doit pas dependre d'une table qu'on pourrait
   * reindexer.
   */
  readonly #blastRadius: Float32Array;
  /**
   * Identifiant de l'arme qui a tire, index dans `WEAPONS` — recopie de
   * `Weapon.id` a l'emission (etape 5a, tache 12).
   *
   * ⚠️ **Purement COSMETIQUE, et c'est le seul champ qui le soit.** Il existe
   * pour que le rendu sache quel projectile dessiner : chaque arme, son
   * apparence propre (`Weapon.look`). La simulation ne le lit jamais — ce qui
   * decide d'un degat, d'une marque ou d'une zone est deja recopie a cote
   * (`#damage`, `#element`, `#by`), justement pour que le tir ne depende pas
   * d'une table.
   *
   * `Uint8Array` : le catalogue en compte treize (tache 9 de l'etape 5b), le
   * §6.2 en projette quarante.
   */
  readonly #weapon: Uint8Array;
  /**
   * Traversees RESTANTES : combien d'ennemis supplementaires ce projectile
   * peut encore transpercer avant d'etre consomme (etape 8). Recopie de
   * `Weapon.pierce` a l'emission, decremente a chaque traversee.
   */
  readonly #pierce: Uint8Array;
  /**
   * Le dernier ennemi touche par ce projectile, ou `-1`.
   *
   * ⚠️ **Sans lui, « transpercer » devient « frapper le meme ennemi a chaque
   * tick ».** Un projectile qui survit a son impact continue sa course, mais
   * la cible qu'il vient de traverser est encore a portee au tick suivant —
   * il la retoucherait, et une fleche a trois traversees infligerait quatre
   * fois ses degats au PREMIER ennemi rencontre au lieu d'en traverser
   * quatre.
   *
   * ponytail: un seul souvenir, donc A -> B -> A reste possible si le
   * projectile recroise sa premiere cible apres une autre. Un ensemble par
   * projectile couterait un tableau de plus par traversee pour un cas que la
   * geometrie rend rare (les projectiles vont droit) ; a revoir si une arme a
   * trajectoire courbe apparait.
   */
  readonly #lastHit: Int32Array;
  /** Pas restants avant expiration. Decremente a chaque `step`. */
  readonly #ticksRemaining: Int32Array;
  /**
   * Position au DEBUT du pas de simulation qui vient de s'ecouler — alimentee
   * par `step`, lue par `collide`. Voir la doc de `collide` : c'est ce qui
   * permet de tester le SEGMENT parcouru pendant le pas plutot que le seul
   * point d'arrivee.
   *
   * Stockee plutot que reconstruite par `x - vx * dt` : reconstruire
   * imposerait a `collide` de connaitre le `dt` du dernier `step`, donc un
   * ordre d'appel implicite entre les deux methodes. La stocker rend
   * `collide` correcte quel que soit le moment ou elle est appelee apres
   * `step`.
   */
  readonly #prevX: Float32Array;
  readonly #prevY: Float32Array;

  #count = 0;

  constructor(readonly capacity: number) {
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.bornTick = new Uint32Array(capacity);
    this.#vx = new Float32Array(capacity);
    this.#vy = new Float32Array(capacity);
    this.#damage = new Float32Array(capacity);
    this.#element = new Uint8Array(capacity);
    this.#by = new Uint8Array(capacity);
    this.#blastRadius = new Float32Array(capacity);
    this.#weapon = new Uint8Array(capacity);
    this.#pierce = new Uint8Array(capacity);
    this.#lastHit = new Int32Array(capacity).fill(-1);
    this.#ticksRemaining = new Int32Array(capacity);
    this.#prevX = new Float32Array(capacity);
    this.#prevY = new Float32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Tire une salve de `weapon` depuis `(x, y)`, visant `targetId` dans
   * `horde`.
   *
   * `horde` doit etre l'etat sur lequel `targetId` a ete choisi — c'est ce
   * qui garantit que la direction visee est, elle aussi, coherente avec la
   * cible retenue.
   *
   * Si `targetId` ne designe plus une entite vivante dans `horde`, la salve
   * ne part pas : sans cible, aucune direction ne serait deterministe des
   * deux cotes, donc rien ne se tire plutot que de deviner.
   *
   * **Cette regle peut faire diverger serveur et client, et c'est accepte.**
   * Les deux visent sur l'etat COURANT de leur propre horde (jamais retarde
   * — voir `nearestTarget`, corrige en tache 9). Si une mort n'est pas
   * encore parvenue au client, sa horde peut encore contenir la cible que le
   * serveur, lui, a deja retiree de la sienne — donc l'un saute le tir
   * pendant que l'autre le lance, ou l'inverse. L'ecart est purement visuel
   * et se resorbe au rejeu du §3.2 : les projectiles ne sont jamais
   * repliques, et les degats restent arbitres par le serveur (§5.4). Ce qui
   * serait inacceptable, ce serait qu'un client tire une conclusion sur les
   * degats a partir de sa propre salve — ce n'est jamais le cas, `fireSalvo`
   * ne fait que deplacer un projectile.
   */
  /**
   * ⚠️ **Aucun appelant en production depuis la tache 13.** La visee suit le
   * curseur, donc les salves partent par `fireSalvoDirected`. Conserve pour
   * l'etape 4 (armes a tete chercheuse) ; ne decrit pas le comportement
   * actuel du jeu.
   */
  fireSalvo(
    weapon: Weapon,
    tick: number,
    x: number,
    y: number,
    targetId: number,
    horde: Horde,
  ): void {
    const targetSlot = horde.slotOf(targetId);
    if (targetSlot < 0) {
      return;
    }

    const dx = (horde.x[targetSlot] ?? 0) - x;
    const dy = (horde.y[targetSlot] ?? 0) - y;
    this.#emit(weapon, tick, x, y, Math.atan2(dy, dx));
  }

  /**
   * Tire une salve de `weapon` depuis `(x, y)`, dans la direction `(dirX,
   * dirY)` — decision de la tache 13 : la visee suit le curseur, elle n'est
   * plus derivee d'une cible (voir `fireSalvo`, qui reste pour d'eventuelles
   * armes futures a ciblage automatique, mais que plus personne n'appelle
   * pour l'arme de base).
   *
   * `(dirX, dirY) = (0, 0)` ne tire pas : c'est la direction qu'envoie un
   * curseur pile sur le joueur, ou une souris jamais bougee, et les DEUX
   * cotes (serveur, chaque client) la voient identique — ne pas tirer est
   * deterministe, choisir une direction par defaut ne le serait pas.
   *
   * Seul l'ANGLE de `(dirX, dirY)` compte (`Math.atan2` ignore la norme) :
   * l'appelant peut donc passer la paire quantifiee sur un octet signe
   * (-127..127) telle quelle, sans la renormaliser — c'est d'ailleurs ce qui
   * est exige : voir `quantizeAxis` dans `shared/protocol.ts`, dont la doc
   * explique pourquoi tirer avec un flottant non quantifie desynchroniserait
   * durablement serveur et client.
   */
  fireSalvoDirected(
    weapon: Weapon,
    tick: number,
    x: number,
    y: number,
    dirX: number,
    dirY: number,
    damage = weapon.damage,
    count = weapon.projectileCount,
    by = 0,
  ): void {
    if (dirX === 0 && dirY === 0) {
      return;
    }
    this.#emit(weapon, tick, x, y, Math.atan2(dirY, dirX), damage, count, by);
  }

  /**
   * Coeur commun a `fireSalvo` et `fireSalvoDirected` : pose `weapon.projectileCount`
   * projectiles, repartis symetriquement autour de `baseAngle`. Factorise pour
   * qu'un decalage d'octet ou de formule ne puisse pas diverger entre les deux
   * points d'entree — seul le calcul de l'angle differe entre eux.
   */
  #emit(
    weapon: Weapon,
    tick: number,
    x: number,
    y: number,
    baseAngle: number,
    damage = weapon.damage,
    count = weapon.projectileCount,
    by = 0,
  ): void {
    const n = count;
    const room = this.capacity - this.#count;
    const toFire = Math.min(n, room);
    // Rend visible une troncature silencieuse. Une salve qui ne part pas est
    // une carte que le joueur a payee et qui ne fait rien : ca ne doit jamais
    // disparaitre sans trace. Meme motif que `RoomMetrics.truncatedSpawns`
    // pour les vagues.
    this.truncatedProjectiles += n - toFire;

    // ⚠️ **Une salve dont l'ouverture fait un TOUR COMPLET est un tir
    // circulaire** (etape 8) — et c'est tout ce qu'il a fallu pour en avoir
    // un : pas un type d'arme de plus, une valeur de plus dans un champ qui
    // existait deja. Ce qui change est la REPARTITION : sur un arc ouvert, les
    // deux extremes tombent sur les bords (`i / (n - 1)`) ; sur un cercle, ces
    // deux bords sont le MEME angle, et le dernier projectile se poserait sur
    // le premier. L'anneau se ferme donc en `i / n`.
    const anneau = weapon.spreadRadians >= Math.PI * 2;
    for (let i = 0; i < toFire; i++) {
      // Repartition symetrique autour de `baseAngle` : a n = 1, le spread
      // n'a pas de sens et est ignore — un seul projectile part droit sur la
      // cible, quelle que soit la valeur de `spreadRadians`.
      const angle = anneau
        ? baseAngle + (Math.PI * 2 * i) / n
        : n > 1
          ? baseAngle + weapon.spreadRadians * (i / (n - 1) - 0.5)
          : baseAngle;

      const slot = this.#count + i;
      this.x[slot] = x;
      this.y[slot] = y;
      // Avant le premier `step`, le segment parcouru est un point : prev =
      // position de depart. Un `collide` appele avant tout mouvement teste
      // donc simplement le point de tir, comme attendu.
      this.#prevX[slot] = x;
      this.#prevY[slot] = y;
      this.#vx[slot] = Math.cos(angle) * weapon.projectileSpeed;
      this.#vy[slot] = Math.sin(angle) * weapon.projectileSpeed;
      this.#damage[slot] = damage;
      this.#element[slot] = weapon.element;
      this.#by[slot] = by;
      this.#blastRadius[slot] = weapon.blastRadius;
      this.#weapon[slot] = weapon.id;
      this.#pierce[slot] = weapon.pierce;
      this.#lastHit[slot] = -1;
      this.#ticksRemaining[slot] = weapon.projectileLifeTicks;
      this.bornTick[slot] = tick;
    }

    this.#count += toFire;
  }

  /**
   * Degats portes par le projectile de ce slot.
   *
   * Depuis l'etape 5a, ce nombre **module l'issue** : `resolveProjectileDamage`
   * le soustrait de `Horde.hp`, et une pietaille lourde (`HEAVY_HP`) survit ou
   * non selon les passifs de degats du tireur. Il reste lisible ici parce que
   * c'est le seul point ou le client peut verifier ce qu'il tire — mais ce
   * n'est plus le seul endroit ou son effet s'observe.
   */
  damageAt(slot: number): number {
    return this.#damage[slot] ?? 0;
  }

  /**
   * Element porte par le projectile de ce slot — voir `#element`.
   *
   * Lu par `resolveProjectileDamage` (back) a l'IMPACT, et seulement la : un
   * projectile MARQUE ce qu'il touche, il ne laisse plus rien au sol (tache 21
   * — c'est la reaction qui pose le champ). Le client, lui, le lit pour teindre
   * la marque qu'il approxime ; les zones, elles, sont ANNONCEES (§5.3).
   */
  elementAt(slot: number): number {
    return this.#element[slot] ?? 0;
  }

  /** Index du joueur qui a tire le projectile de ce slot — voir `#by`. */
  ownerAt(slot: number): number {
    return this.#by[slot] ?? 0;
  }

  /**
   * Rayon de l'explosion a l'impact du projectile de ce slot — voir
   * `#blastRadius`. Lu par `resolveProjectileDamage` (back) a l'IMPACT, et
   * seulement la.
   */
  blastRadiusAt(slot: number): number {
    return this.#blastRadius[slot] ?? 0;
  }

  /**
   * Arme qui a tire le projectile de ce slot — voir `#weapon`. Lu par le seul
   * rendu (`ProjectileRenderer`), qui y trouve la forme, la taille, la teinte,
   * le halo et la trainee a dessiner.
   */
  weaponAt(slot: number): number {
    return this.#weapon[slot] ?? 0;
  }

  /**
   * Pas restants avant expiration — voir `#ticksRemaining`.
   *
   * ⚠️ **Le rendu lit CE compte a rebours, jamais `tick - bornTick`.** Les
   * deux diraient la meme chose tant que le tick du dessin suit exactement
   * celui de la simulation ; le compte a rebours, lui, le dit sans hypothese
   * — et il n'oblige pas la boucle de rendu a se faire passer un tick de plus.
   * C'est ce que `projectileAlpha` attend.
   */
  ticksRemainingAt(slot: number): number {
    return this.#ticksRemaining[slot] ?? 0;
  }

  /**
   * Direction de vol du projectile de ce slot, en radians.
   *
   * Calculee a la demande plutot que stockee : la vitesse d'un projectile ne
   * change jamais apres l'emission, mais un onzieme tableau par projectile
   * couterait de la memoire a chaque tir pour une valeur que seul le rendu
   * lit, une fois par image et seulement pour ce qui est a l'ecran.
   */
  headingAt(slot: number): number {
    return Math.atan2(this.#vy[slot] ?? 0, this.#vx[slot] ?? 0);
  }

  /**
   * Projectiles qu'une salve n'a pas pu poser faute de place, cumules depuis la
   * creation. Jamais remis a zero par `Projectiles` : c'est `Room` qui draine
   * ses metriques.
   *
   * ⚠️ **Ce compteur existe parce que l'empilement a leve la borne.** Jusqu'a
   * ce que les armes s'empilent, quatre joueurs aux slots pleins tenaient une
   * centaine de projectiles simultanes contre une capacite de 256, et la marge
   * tenait toute seule. Un exemplaire supplementaire elargit desormais la salve
   * sans borne : la capacite peut etre atteinte, et sans ce compteur la salve
   * manquante ne se verrait nulle part.
   */
  truncatedProjectiles = 0;

  /**
   * Un pas de simulation. Appele exactement une fois par tick, `dt` fixe.
   *
   * ⚠️ **Un rappel `onExpire(slot)` a vecu ici, de la tache 6 a la tache 21 de
   * l'etape 5a.** Il servait la moitie « n'a rien touche » du modele ou un
   * projectile elementaire posait une zone au bout de sa course. Depuis que
   * c'est la REACTION qui laisse un champ au sol (§5.1 de la spec, tache 21),
   * plus rien ne s'interesse a la mort de vieillesse d'un projectile : le
   * parametre est parti avec son seul appelant, aucun test ne le tenait, et un
   * point d'extension que personne n'utilise est un point d'extension qui ment.
   */
  step(dt: number, onExpire?: (slot: number) => void): void {
    for (let i = 0; i < this.#count; i++) {
      // Capture la position de DEBUT de pas avant de la faire avancer : c'est
      // le point de depart du segment que `collide` testera.
      this.#prevX[i] = this.x[i] ?? 0;
      this.#prevY[i] = this.y[i] ?? 0;
      this.x[i] = (this.x[i] ?? 0) + (this.#vx[i] ?? 0) * dt;
      this.y[i] = (this.y[i] ?? 0) + (this.#vy[i] ?? 0) * dt;
      this.#ticksRemaining[i] = (this.#ticksRemaining[i] ?? 0) - 1;
    }

    // Retrait par indice decroissant, meme raisonnement que `Horde.kill` :
    // un projectile deplace dans un trou par une compaction ne doit jamais
    // etre lui-meme retire par erreur ensuite.
    for (let i = this.#count - 1; i >= 0; i--) {
      if ((this.#ticksRemaining[i] ?? 0) <= 0) {
        // ⚠️ **AVANT `#removeAt`, pendant que le creneau est encore valide** :
        // l'appelant y lit la position, le souffle et les degats du projectile
        // qui s'eteint — exactement la fenetre que `collide` ouvre a l'impact.
        //
        // ⚠️ **Ce rappel RESSEMBLE a celui que la tache 21 a retire, et il ne
        // fait pas la meme chose.** L'ancien servait le modele ou un projectile
        // POSAIT une zone en fin de course ; celui-ci ne pose rien, il rend
        // seulement la main — et c'est l'appelant qui decide, aujourd'hui pour
        // faire sauter une arme de souffle qui n'a percute personne.
        onExpire?.(i);
        this.#removeAt(i);
      }
    }
  }

  /**
   * Resout les collisions avec `horde` : pour chaque projectile touchant une
   * entite, appelle `onHit(entityId, damage)` et consomme le projectile.
   *
   * **Teste le SEGMENT parcouru pendant le dernier `step`, pas seulement le
   * point d'arrivee.** Un projectile rapide peut parcourir plusieurs
   * dizaines de pixels en un seul tick ; une entite qui coupe sa trajectoire
   * AU MILIEU du pas peut se trouver hors du rayon des deux extremites tout
   * en etant a l'interieur du rayon du segment lui-meme — c'est exactement
   * le cas que le test de reproduction de ce fichier verifie : une entite a
   * 30 px du segment mais a ~33,5 px de chacune de ses deux extremites,
   * touchee uniquement parce que la distance mesuree est celle au segment.
   * Se limiter au point d'arrivee la manquerait, et le defaut s'aggraverait
   * avec la vitesse — precisement la ou on voudrait le plus de fiabilite.
   *
   * A egalite, le plus petit identifiant gagne — meme departage que
   * `nearestTarget`, pour la meme raison : le resultat ne doit pas dependre
   * de l'ordre des entites dans le tableau.
   *
   * ⚠️ **Un projectile TRANSPERCANT n'est pas consomme** (etape 8) : tant
   * qu'il lui reste des traversees (`Weapon.pierce`, recopie a l'emission), il
   * poursuit sa course apres avoir appele `onHit`, et il inflige ses degats
   * PLEINS a chaque corps. Il ne peut jamais toucher deux fois de suite le
   * meme — voir `#lastHit`, sans quoi « transpercer » voudrait dire « frapper
   * le premier ennemi quatre fois ».
   *
   * ⚠️ **Le rayon teste suit le CORPS de la cible depuis l'etape 8** : un boss
   * (`Archetype.bodyScale` = 3) encaisse sur 96 px de rayon, la pietaille sur
   * 32. Voir `HIT_R2_BY_ARCHETYPE` — jusque-la, il fallait viser le centre
   * exact d'un corps dessine a 240 px de diametre.
   *
   * ⚠️ **`zones`/`tick` sont optionnels, et c'est ce qui branche le rayon de
   * touche elargi du Vif-argent (§4 de la spec de l'etape 5c) COTE SERVEUR
   * SEUL.** `back/src/combat.ts` les passe ; le client (`front/src/net/client.ts`,
   * ses projectiles cosmetiques) appelle `collide` sans eux, et retombe donc
   * exactement sur le rayon de base — aucun changement de comportement pour
   * lui. Ceci ne touche AUCUNE trajectoire : `zones` n'entre jamais dans
   * `#emit`/`fireSalvoDirected`, qui restent aveugles a la horde et aux
   * zones — voir le docbloc du module.
   */
  collide(
    horde: Horde,
    onHit: (entityId: number, damage: number, slot: number) => void,
    zones?: ZoneField,
    tick?: number,
  ): void {
    const defaultR2 = PROJECTILE_HIT_RADIUS * PROJECTILE_HIT_RADIUS;

    for (let i = this.#count - 1; i >= 0; i--) {
      const ax = this.#prevX[i] ?? 0;
      const ay = this.#prevY[i] ?? 0;
      const bx = this.x[i] ?? 0;
      const by = this.y[i] ?? 0;

      let bestId = -1;
      let bestDist2 = Number.POSITIVE_INFINITY;
      for (let e = 0; e < horde.count; e++) {
        const ex = horde.x[e] ?? 0;
        const ey = horde.y[e] ?? 0;
        const d2 = distanceToSegmentSquared(ex, ey, ax, ay, bx, by);
        // Le rayon de CE corps : `PROJECTILE_HIT_RADIUS` pour les vingt
        // archetypes de pietaille, trois fois plus pour le boss. Voir
        // `HIT_R2_BY_ARCHETYPE`.
        const kind = horde.archetype[e] ?? 0;
        const baseR2 = HIT_R2_BY_ARCHETYPE[kind] ?? defaultR2;
        if (d2 > baseR2) {
          // ⚠️ **Le rayon de base ne touche pas — le rayon ELARGI est-il
          // pose, et seulement s'il y a un `zones` a consulter ?** Cout
          // supplementaire nul pour le client (`zones` est `undefined`, donc
          // `continue` immediat) et pour le cas courant serveur (aucune zone
          // de Vif-argent sur ce point).
          if (!zones) {
            continue;
          }
          // ⚠️ **Pre-filtre AVANT le balayage, et c'est une borne SUPERIEURE
          // EXACTE, pas une approximation.** `hitRadiusBonusAt` est en
          // O(zones) : l'appeler ici le mettait dans la boucle
          // projectile x ennemi, donc un cout en projectiles x ennemis x
          // zones — **49 millions de tests de distance par tick** mesures a
          // 4 000 ennemis, 96 projectiles et 128 zones (banc des six
          // elements, etape 5c). Aucun bonus ne depasse
          // `VIF_ARGENT_HIT_RADIUS_BONUS`, donc un ennemi au-dela de
          // `PROJECTILE_HIT_RADIUS + VIF_ARGENT_HIT_RADIUS_BONUS` ne peut
          // etre touche par AUCUNE zone : le balayage ne sert plus qu'a
          // l'anneau, une poignee d'entites.
          //
          // ⚠️ **AUCUN test ne peut separer ce pre-filtre de son absence** —
          // c'est une optimisation a comportement identique. Ce qui le garde
          // est le BANC, pas la suite ; meme honnetete que la borne `<= 0` de
          // `resolveBurn`, qui assume qu'aucun test ne la distingue de `< 0`.
          if (d2 > (WIDE_R2_BY_ARCHETYPE[kind] ?? defaultR2)) {
            continue;
          }
          const bonus = zones.hitRadiusBonusAt(ex, ey, tick ?? 0);
          if (bonus <= 0) {
            continue;
          }
          // Le bonus de zone s'AJOUTE au rayon du corps, il ne le remplace
          // pas : un boss dans une flaque de Vif-argent reste un boss.
          const wideR = Math.sqrt(baseR2) + bonus;
          if (d2 > wideR * wideR) {
            continue;
          }
        }
        const id = horde.entityIdAt(e);
        // Jamais deux fois de suite le meme corps — voir `#lastHit`.
        if (id === this.#lastHit[i]) {
          continue;
        }
        if (d2 < bestDist2 || (d2 === bestDist2 && id < bestId)) {
          bestDist2 = d2;
          bestId = id;
        }
      }

      if (bestId >= 0) {
        // `i` est passe pour que l'appelant puisse lire ce que le projectile
        // porte d'autre que ses degats — son element, son tireur, sa position
        // d'impact (etape 5a, tache 6). Valide seulement pendant le rappel :
        // `#removeAt` juste apres deplace le dernier projectile dans ce
        // creneau.
        onHit(bestId, this.#damage[i] ?? 0, i);
        // ⚠️ **Le degat est PLEIN a chaque traversee** (voir `Weapon.pierce`) :
        // `onHit` vient d'etre appele avant ce test, et il l'est de la meme
        // facon au premier ennemi qu'au dernier. Ce qui se consomme, c'est le
        // droit de continuer.
        const restantes = this.#pierce[i] ?? 0;
        if (restantes > 0) {
          this.#pierce[i] = restantes - 1;
          this.#lastHit[i] = bestId;
        } else {
          this.#removeAt(i);
        }
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
      this.#vx[slot] = this.#vx[last] ?? 0;
      this.#vy[slot] = this.#vy[last] ?? 0;
      this.#damage[slot] = this.#damage[last] ?? 0;
      this.#element[slot] = this.#element[last] ?? 0;
      this.#by[slot] = this.#by[last] ?? 0;
      this.#blastRadius[slot] = this.#blastRadius[last] ?? 0;
      this.#weapon[slot] = this.#weapon[last] ?? 0;
      this.#pierce[slot] = this.#pierce[last] ?? 0;
      this.#lastHit[slot] = this.#lastHit[last] ?? -1;
      this.#ticksRemaining[slot] = this.#ticksRemaining[last] ?? 0;
      this.#prevX[slot] = this.#prevX[last] ?? 0;
      this.#prevY[slot] = this.#prevY[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Distance au carre entre le point `(px, py)` et le SEGMENT `(ax, ay)` —
 * `(bx, by)`. Projection classique, parametre borne a `[0, 1]` pour rester
 * sur le segment plutot que sur la droite qui le porte.
 *
 * Au carre pour eviter une racine par paire projectile/entite : seule la
 * comparaison au carre du rayon compte dans `collide`.
 */
export function distanceToSegmentSquared(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abLenSq = abx * abx + aby * aby;
  const t = abLenSq > 0 ? clamp01(((px - ax) * abx + (py - ay) * aby) / abLenSq) : 0;
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}
