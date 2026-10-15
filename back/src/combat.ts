import {
  archetypeOf,
  KAMIKAZE_MONSTER_DAMAGE,
  KAMIKAZE_PLAYER_DAMAGE,
  KAMIKAZE_RADIUS,
  SHAMAN_AURA_REDUCTION,
  SHIELD_BLOCK,
} from '@shared/archetypes';
import { BOSS_CHARGE_DAMAGE, type BossCharge, chargeHurtsAt } from '@shared/boss';
import { chainTargets } from '@shared/chain';
import {
  CHAIN_JUMPS,
  CHAIN_RADIUS,
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  COURT_CIRCUIT_MAX_JUMPS,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SEPARATION_RADIUS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { type Horde, leavesDrop } from '@shared/horde';
import { linkedNeighbours } from '@shared/links';
import { distanceToSegmentSquared, type Projectiles } from '@shared/projectiles';
import { packElementPair, packZoneKind, zoneElement } from '@shared/protocol';
import { REACTION, reactionForPair } from '@shared/reactions';
import { NEUTRE_MARQUE_AMP } from '@shared/weapons';
import type { ZoneField } from '@shared/zones';

/**
 * L'arbitrage de combat, cote serveur : degats de projectiles, morts, contact
 * avec les joueurs, ramassage d'orbes — les etapes 8 a 10 de la sequence de
 * `Room.step` (voir l'en-tete de `room.ts`).
 *
 * Comme `room.ts`, ce fichier ne connait ni `ws` ni `fastify` (regle Biome,
 * voir `biome.json`) — meme raison : c'est ce qui rend le passage a
 * `worker_threads` mecanique, et ce qui permet de tester l'arbitrage ici sans
 * lancer de serveur.
 *
 * ⚠️ **Depuis l'etape 5a, la pietaille a une reserve de points de vie** —
 * `Archetype.hp`, posee par `Horde.spawn`, soustraite ICI et nulle part
 * ailleurs. `Weapon.damage` cesse d'etre inerte, et avec lui les deux passifs
 * de degats (« puissance », « acier ») qui ne modulaient aucune issue a
 * l'etape 4.
 *
 * Le rythme de mise a mort de l'etape 3 est preserve **par construction** :
 * `LIGHT_HP` vaut exactement les degats de la dague, donc la pietaille legere
 * meurt toujours en un coup. Seule la pietaille lourde (`HEAVY_HP`, quatre
 * coups) change quelque chose — assez pour porter une marque elementaire et
 * reagir, ce que le §3.3 de la spec exige.
 *
 * **Les PV ne quittent jamais le serveur** (§2 de la spec) : le client apprend
 * qui meurt par `DEATHS`, comme depuis l'etape 3. Rien de nouveau sur le fil.
 */

/**
 * Un joueur tel que l'arbitrage de contact le voit : position en lecture,
 * points de vie et compte a rebours d'invulnerabilite mutables.
 *
 * Interface structurelle plutot que classe : `Room.PlayerState` la satisfait
 * directement, sans adaptateur — `resolveContact` modifie les objets qu'on
 * lui passe EN PLACE, comme `Horde.step` modifie une `Horde` en place.
 *
 * ⚠️ **`resolvePickups`, lui, n'est plus dans ce cas depuis la tache 7 de
 * l'etape 7b** : il prend des `PickupPoint`, pas des `ContactPlayer` —
 * `Room.PlayerState` ne porte pas `pickupRadius` directement, et `room.ts`
 * construit desormais un adaptateur (`.map((p) => ({ x, y, pickupRadius }))`)
 * avant d'appeler `resolvePickups`.
 */
export interface ContactPlayer {
  readonly x: number;
  readonly y: number;
  hp: number;
  /** Ticks restants avant qu'un nouveau contact puisse a nouveau faire mal. */
  contactInvulnTicks: number;
  /**
   * Fraction des degats recus absorbee (amelioration « Armure » du compte).
   * Optionnelle : absente, elle vaut 0 — les tests de contact n'ont rien a poser.
   */
  readonly armor?: number;
}

/**
 * Un point que `resolvePickups` compare aux orbes vivants.
 *
 * ⚠️ **N'est PLUS un sous-ensemble structurel de `ContactPlayer`** depuis la
 * tache 7 de l'etape 7b : `pickupRadius` est personnel (base plus achats
 * d'aimant), et `ContactPlayer` ne le porte pas — un `ContactPlayer` ne
 * satisfait donc plus `PickupPoint` sans qu'on le lui ajoute.
 */
export interface PickupPoint {
  readonly x: number;
  readonly y: number;
  /** Rayon de ramassage de CE joueur : `ORB_PICKUP_RADIUS` plus ses achats. */
  readonly pickupRadius: number;
}

/**
 * Orbes vivants, derives des morts (§6.1 de la spec) : chaque mort de
 * monstre laisse un orbe a sa position, portant l'identite du monstre —
 * « rien a allouer, rien a synchroniser ». Tableaux types, jamais un objet
 * par orbe, meme raisonnement que `Horde` et `Projectiles`.
 *
 * ⚠️ **UN ORBE NE S'EVAPORE PLUS** (etape 6a, tache 15, sur retour de jeu :
 * *« l'xp ne doit pas disparaitre »*). `ORB_LIFETIME_TICKS` et la methode
 * `expire` qui le lisait ont ete SUPPRIMES des deux cotes du fil, ensemble —
 * une peremption retiree d'un seul cote ferait disparaitre chez l'un un orbe
 * que l'autre ramasse encore.
 *
 * ⚠️ **La CAPACITE est donc devenue la seule borne, et elle est SILENCIEUSE** :
 * `spawn` revient sans rien faire quand la reserve est pleine. C'est pour ca
 * que `truncatedOrbs` existe — une chose qui ne se pose pas est un effet paye
 * qui disparaitrait sans trace, exactement le role que
 * `Projectiles.truncatedProjectiles` et `ZoneField.truncatedZones` jouent
 * deja.
 *
 * Capacite bornee a `MAX_ENTITIES` (4000, passee par l'appelant) : au plus un
 * orbe vit par mort, et une mort sur `ORB_DROP_ONE_IN` en laisse un.
 *
 * **Et c'est MESURE, parce que la capacite ne servait a rien tant que
 * l'expiration vidait la reserve toute seule.** Decor de `kills.bench.ts` —
 * quatre joueurs immobiles, douze graines de carte — mais tenus en vie de
 * force (400 cartes de vitalite) pour que la run dure : sans ca elle s'arrete
 * vers 78 s et ne dit rien d'une run longue.
 *
 * | Duree de jeu | Orbes au sol, au pic | Moyenne en fin de run | Tronques |
 * | --- | --- | --- | --- |
 * | 78 s (run naturelle) | 82 | 54 | **0** |
 * | 600 s (joueurs tenus en vie) | **597** | 344 | **0** |
 *
 * Personne ne bouge, donc **aucun de ces orbes n'est jamais ramasse** : c'est
 * le pire cas, pas le cas courant. Meme ainsi, dix minutes de jeu occupent
 * 15 % de la reserve, et la horde (3 900 sur 4 000) sature bien avant elle.
 * La borne tient tres largement.
 */
export class OrbField {
  /** Identite du monstre qui a laisse l'orbe. Public en lecture, comme `Horde.entityIdAt`. */
  readonly id: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /*
   * ⚠️ **`bornTick` a disparu de cette classe AVEC l'expiration** (tache 15).
   * Il n'existait que pour la dater : plus rien cote serveur ne lisait ce
   * tableau une fois `expire` supprimee, et un `Uint32Array(MAX_ENTITIES)`
   * qu'on remplit sans jamais le relire est du code qui ment.
   *
   * ⚠️ **`DerivedOrbs` garde le sien, et ce n'est PAS une divergence** :
   * `OrbRenderer` en tire la phase du scintillement, donc il y a la-bas un
   * lecteur. La regle partagee etait la PEREMPTION, et elle est partie des
   * deux cotes ensemble.
   */
  /**
   * Orbes qu'une mort a demandes et que la reserve pleine n'a pas poses,
   * depuis le debut de la run. Cumulatif, jamais remis a zero — c'est un
   * compteur de RUN, comme `Projectiles.truncatedProjectiles` et
   * `ZoneField.truncatedZones`.
   *
   * ⚠️ **Compte les orbes REFUSES PAR LA CAPACITE, pas les morts sans orbe.**
   * Trois morts sur quatre ne laissent rien (`dropsOrb`) et c'est la regle du
   * jeu ; ce compteur ne doit jamais les compter, sans quoi il monterait tout
   * le temps et ne dirait plus rien du plafond qu'il est cense surveiller.
   */
  truncatedOrbs = 0;
  #count = 0;

  constructor(readonly capacity: number) {
    this.id = new Uint32Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Une mort DEMANDE un orbe ; toutes ne l'obtiennent pas (tache 17, etape 5a).
   *
   * ⚠️ **Depuis la tache 14 de l'etape 6a, la reserve tient DEUX natures** :
   * les orbes d'experience et les PIECES. Elle ne le sait pas — la nature se
   * relit de l'identite (`dropsOrb` / `dropsCoin`, disjoints) la ou elle sert,
   * c'est-a-dire au dessin et au ramassage. Une seconde reserve aurait demande
   * une seconde capacite, un second compteur de troncature et un second calque
   * de rendu, pour un objet qui tombe au meme endroit et se ramasse au meme
   * rayon.
   *
   * ⚠️ **La garde est ICI, au goulot, et pas aux trois chemins de mort.** Les
   * projectiles, les brulures et les reactions appellent tous les trois cette
   * methode, et l'etape 5a vient d'en ajouter deux : une regle recopiee a
   * chaque appel serait fausse au prochain chemin ajoute — c'est exactement ce
   * qui est arrive aux zones (« n'en cabler qu'une laisserait la moitie des
   * tirs sans trace au sol »). Une seule garde, au seul endroit qui les voit
   * toutes.
   *
   * ⚠️ **`DerivedOrbs.spawn` porte la MEME garde, cote client**, et c'est la
   * seule duplication acceptable : les deux classes sont deja jumelles de part
   * et d'autre du fil, et le predicat qu'elles partagent, lui, vit dans
   * `shared/` (`dropsOrb`). Retirer la garde d'un seul cote ferait apparaitre
   * chez l'un des orbes que l'autre ignore.
   *
   * ⚠️ **Ignore silencieusement si la capacite est atteinte — mais le COMPTE.**
   * Depuis que l'expiration a disparu (tache 15), c'est la seule borne de la
   * reserve : un refus qui ne laisserait aucune trace serait de l'experience
   * gagnee qui s'evapore, c'est-a-dire exactement ce que cette tache retire.
   */
  spawn(entityId: number, x: number, y: number): void {
    if (!leavesDrop(entityId)) {
      return;
    }
    if (this.#count >= this.capacity) {
      this.truncatedOrbs++;
      return;
    }
    const slot = this.#count++;
    this.id[slot] = entityId;
    this.x[slot] = x;
    this.y[slot] = y;
  }

  /**
   * Etape 10 de la sequence serveur : resout les ramassages. Rend les
   * identites ramassees (= celles des monstres qui les ont laissees), pour le
   * message PICKUPS et le calcul de l'experience gagnee, cote `Room`.
   *
   * ⚠️ **Le RAMASSAGE est desormais la seule sortie d'un orbe.** Cette methode
   * commencait par une passe d'expiration ; la tache 15 l'a supprimee avec la
   * constante qu'elle lisait. Un orbe attend donc indefiniment qu'on vienne le
   * chercher, et `tick` ne sert plus qu'a dater ce qu'il devient.
   *
   * Retrait par indice decroissant, meme raisonnement que `Horde.kill` et
   * `Projectiles.#removeAt` : un orbe deplace dans un trou par une
   * compaction ne doit jamais etre lui-meme saute par erreur ensuite.
   */
  resolvePickups(players: readonly PickupPoint[]): number[] {
    // ⚠️ **Precalcule hors des deux boucles.** Le `r2` etait hoiste parce qu'il
    // etait unique ; maintenant qu'il y en a un par joueur, le recalculer dans
    // la boucle interne le ferait pour chaque orbe ET chaque joueur. Un tableau
    // parallele garde exactement le meme cout qu'avant.
    const r2 = players.map((p) => p.pickupRadius * p.pickupRadius);
    const picked: number[] = [];
    for (let i = this.#count - 1; i >= 0; i--) {
      const ox = this.x[i] ?? 0;
      const oy = this.y[i] ?? 0;
      let caught = false;
      for (let j = 0; j < players.length; j++) {
        const p = players[j];
        if (!p) {
          continue;
        }
        const dx = ox - p.x;
        const dy = oy - p.y;
        if (dx * dx + dy * dy <= (r2[j] ?? 0)) {
          caught = true;
          break;
        }
      }
      if (caught) {
        picked.push(this.id[i] ?? 0);
        this.#removeAt(i);
      }
    }
    return picked;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.id[slot] = this.id[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
    }
    this.#count = last;
  }
}

/**
 * Une reaction qui vient d'etre declenchee, avant qu'elle ne soit resolue et
 * annoncee — etape 5a, §6 de la spec.
 *
 * ⚠️ **Porte les DEUX joueurs, alors que le message `REACTION` n'en porte
 * aucun.** C'est exactement la distinction du §6.1 (constat R20 de la tache
 * 5) : le serveur COMPARE deux identites, le fil ne transporte que le booleen
 * qui en sort. `markBy` et `by` existent donc ici, et nulle part ailleurs — la
 * comparaison qui charge la barre de Synergie (§7) est faite par `Room.step`,
 * qui est aussi le seul endroit ou la barre existe.
 */
export interface ReactionTrigger {
  /** Le couple d'elements, deja canonicalise par `packElementPair`. */
  pair: number;
  x: number;
  y: number;
  /** Joueur qui avait applique le PREMIER element : la marque, ou la zone deja posee. */
  markBy: number;
  /** Joueur qui applique le SECOND element — celui qui declenche. */
  by: number;
  /**
   * Le SECOND element, celui qui declenche — **et c'est lui que porte le champ
   * laisse au sol** (tache 21). `pair` ne suffit pas : il est canonicalise,
   * donc il a perdu qui des deux est arrive en premier.
   *
   * ⚠️ **Le second, pas celui de la marque, et c'est mesure.** Le §6.4 de
   * l'orientation ne donne aucune regle de position — la zone de *Surchauffe*
   * (Braise + Foudre) brule, celle de *Verglas* (Givre + Poix) glisse, celle
   * d'*Arc caustique* (Foudre + Chaux) ronge : l'effet appartient au COUPLE,
   * et *Choc thermique* n'en a aucun d'ecrit. Le choix revient donc a cette
   * etape, et un seul des deux ne degenere pas :
   *
   * | Le champ porte | Ce qui arrive au tick suivant |
   * | --- | --- |
   * | l'element de la MARQUE | le champ remarque l'ennemi de l'element que la reaction venait de consommer — le meme tireur redeclenche, **indefiniment, avec une seule arme** |
   * | l'element qui DECLENCHE | le champ remarque du SECOND element ; le meme tireur ne fait plus que rafraichir (§6.2, quatrieme ligne), et il faut de nouveau l'autre element |
   *
   * Mesure, mutation appliquee et non raisonnee — decor de
   * `room.test.ts` « une reaction declenchee par un IMPACT est annoncee » :
   * quarante ticks, UNE arme de Givre, UNE marque de Braise posee une seule
   * fois. **37 reactions avec l'element de la marque, 1 avec celui qui
   * declenche.** La boucle que l'auteur decrit (« un projectile marque, un
   * second element declenche, la reaction laisse un champ ») exige le second :
   * avec le premier, le second element devient inutile apres le premier coup.
   *
   * `by` suit le meme raisonnement : le champ appartient a qui l'a declenche,
   * si bien qu'une reaction ulterieure sur ce champ compare deux identites
   * reellement differentes (§7) au lieu de rejouer une charge deja comptee.
   */
  element: number;
  /**
   * L'identite de l'ennemi qui a declenche cette reaction — `undefined` pour
   * un declencheur ne d'un recouvrement de zones (`onZoneCreated`), qui n'a
   * pas d'ennemi associe (tache 6 de l'etape 5b).
   *
   * ⚠️ **Ne sert QU'a Court-circuit, pour s'exclure de sa propre chaine.** Sans
   * elle, le premier saut de `chainWhilePoisoned` — mesure depuis la position
   * de CET ennemi — le retrouverait a distance nulle et la chaine sauterait
   * sur elle-meme, exactement le piege que `resolveProjectileDamage` evite
   * deja pour la chaine de Foudre. Ne voyage jamais : absent de
   * `ReactionEvent`/`ReactionMessage`.
   */
  entityId?: number;
}

/**
 * Les reactions declenchees pendant un tick, et la borne du §6.2 :
 * **une reaction par ennemi et par tick, au plus.**
 *
 * ⚠️ **Les reactions sont COLLECTEES pendant le tick et resolues a la fin,
 * jamais au fil de l'eau.** Resoudre une reaction tue, et tuer compacte la
 * horde (`Horde.kill`) : le faire depuis `markInZones` ou depuis le rappel de
 * `Projectiles.collide` invaliderait les indices de la boucle qui tourne. Un
 * declencheur ne retient donc qu'une POSITION, qui ne bouge pas, jamais un
 * creneau, qui bouge.
 *
 * ⚠️ **La borne se compte par IDENTITE, pas par creneau**, pour la meme
 * raison : `resolveProjectileDamage` compacte la horde entre le moment ou un
 * projectile declenche et celui ou une zone declencherait. Les identites, elles,
 * survivent a la compaction (`Horde.entityIdAt`).
 *
 * ⚠️ **Ce que la borne empeche n'est PAS ce que le §6.2 decrit, et la
 * difference se compte.** La spec dit : *« une zone Givre posee sur vingt
 * ennemis marques Braise declenche vingt reactions au meme tick »*. Vingt est
 * le compte AVEC la borne aussi — elle est par ENNEMI, pas par tick, et
 * l'etouffer a une seule reaction eteindrait dix-neuf flashs legitimes. Ce
 * qu'elle empeche, c'est la MULTIPLICATION : des zones d'elements alternes
 * remarquent un ennemi entre deux reactions, et il rebondit de l'une a l'autre
 * autant de fois qu'il y a de zones sur lui. Trois zones Givre/Braise/Givre
 * sur vingt ennemis font quarante reactions sans la borne, vingt avec —
 * chacune infligeant `REACTION_DAMAGE` a tout ce qui l'entoure. Le §6.2 a
 * raison sur le risque (*« la cascade est un risque de cout autant que de
 * lisibilite »*), pas sur le chiffre qui l'illustre.
 */
export class Reactions {
  #pending: ReactionTrigger[] = [];
  /** Identites ayant deja reagi depuis le dernier `drain`. */
  readonly #reacted = new Set<number>();

  /** Nombre de reactions en attente de resolution. */
  get count(): number {
    return this.#pending.length;
  }

  /**
   * Declenche une reaction SUR un ennemi, si sa borne du tick le permet.
   *
   * Rend `true` si la reaction a lieu — c'est cette reponse, et elle seule,
   * qui dit a l'appelant si la marque se consomme (§4.3) ou si le second
   * element se contente de la remplacer.
   */
  onEntity(entityId: number, trigger: ReactionTrigger): boolean {
    if (this.#reacted.has(entityId)) {
      return false;
    }
    this.#reacted.add(entityId);
    this.#pending.push(trigger);
    return true;
  }

  /**
   * Declenche les reactions dues a la zone qui vient d'etre CREEE dans le
   * creneau `created` : une par zone vivante d'un autre element dont le disque
   * coupe le sien (§5.2 / §6.2).
   *
   * ⚠️ **`overlaps`, pas la regle de fusion — c'est le facteur 2 de R19.**
   * Deux zones reagissent quand leurs DISQUES sont secants (distance
   * < `2 × ZONE_RADIUS`, ce que `ZoneField.overlaps` calcule) ; la fusion a la
   * pose, elle, regarde si le CENTRE tombe dans une zone existante (distance
   * < `ZONE_RADIUS`). Confondre les deux a deja coute un facteur 2 a la tache
   * 4, et le confondre ICI ferait rater les recouvrements les plus francs.
   *
   * ⚠️ **A LA CREATION DE LA SECONDE, une seule fois** (§6.2) : c'est pour ca
   * que l'appelant ne passe ici que sur une zone reellement creee, jamais sur
   * un rafraichissement. Sinon deux zones qui se recouvrent reagiraient a
   * CHAQUE tick de leur vie commune — et une arme elementaire entretient une
   * zone par fusion, donc indefiniment.
   *
   * ⚠️ **La borne par ennemi ne s'applique pas ici : il n'y a pas d'ennemi.**
   * Ce qui borne ce chemin, c'est qu'il ne tourne qu'a la creation d'une zone,
   * et que la regle de fusion borne deja le nombre de creations par la surface
   * couverte.
   *
   * ⚠️ **Aucune zone n'est consommee, contrairement au §5.2 de la spec.** Voir
   * le rapport de cette tache : la mort d'une zone n'est jamais annoncee (§8),
   * le client la derive du seul `bornTick`, et le Givre RALENTIT (tache 6).
   * Un serveur qui retirerait une zone que le client garde ferait diverger le
   * deplacement — le contrat a 0,000 px du §2 tombe. Le §6.2, lui, borne deja
   * ce chemin a une fois par couple ; c'est cette borne-la qui est
   * implementee.
   */
  onZoneCreated(zones: ZoneField, created: number, tick: number): void {
    const element = zoneElement(zones.kind[created] ?? 0);
    const by = zones.by[created] ?? 0;
    for (let i = 0; i < zones.count; i++) {
      // ⚠️ **Deux gardes ont ete RETIREES ici, mutation a l'appui** — chacune
      // survivait parce qu'une autre la couvrait :
      //
      // - `i === created`, la zone qui vient de naitre : elle porte forcement
      //   `element`, donc la comparaison ci-dessous l'ecarte deja ;
      // - `other === ELEMENT.NEUTRE` : `postZone` est le SEUL createur de
      //   zones, et il ne pose que l'element d'un declencheur — jamais neutre
      //   par construction, voir `ReactionTrigger.element`.
      //
      // Une garde qu'aucun test ne peut faire rougir est une garde qu'on
      // croit avoir.
      const other = zoneElement(zones.kind[i] ?? 0);
      if (other === element) {
        continue;
      }
      if (!zones.aliveAt(i, tick) || !zones.overlaps(created, i)) {
        continue;
      }
      this.#pending.push({
        pair: packElementPair(other, element),
        // « A la frontiere commune » (§5.2) : le milieu des deux centres. Deux
        // disques de meme rayon qui se coupent y ont leur corde commune, et
        // c'est le seul point que les deux zones designent sans arbitraire.
        x: ((zones.x[i] ?? 0) + (zones.x[created] ?? 0)) / 2,
        y: ((zones.y[i] ?? 0) + (zones.y[created] ?? 0)) / 2,
        markBy: zones.by[i] ?? 0,
        by,
        // Le SECOND element, comme partout : ici c'est celui de la zone qui
        // vient de naitre, l'autre etant deja la. Voir `ReactionTrigger`.
        element,
      });
    }
  }

  /**
   * Rend les reactions du tick et **remet la borne par ennemi a zero**.
   *
   * Les deux ensemble, delibrement : la borne est « par tick », et un appelant
   * qui viderait la file sans vider l'ensemble des ennemis ayant reagi
   * empecherait toute reaction pour le reste de la partie.
   */
  drain(): ReactionTrigger[] {
    const out = this.#pending;
    this.#pending = [];
    this.#reacted.clear();
    return out;
  }
}

/**
 * Applique un element sur l'ennemi du creneau `slot` : **le §6.2 en entier, et
 * le seul endroit ou il est decide.**
 *
 * | Ce que porte l'ennemi | Ce qui arrive |
 * | --- | --- |
 * | rien (ou une marque perimee) | la marque se pose |
 * | le MEME element | la marque se rafraichit — **pas de reaction** |
 * | un AUTRE element | reaction, et la marque se CONSOMME (§4.3) |
 *
 * ⚠️ **Un ennemi ressort NU d'une reaction.** Le second element n'est pas pose
 * a la place du premier : les deux se sont consommes. Poser le declencheur
 * ferait de deux zones d'elements opposes une machine a reactions — l'ennemi
 * y rebondirait d'un element a l'autre a chaque tick, ce que la borne par
 * ennemi n'empeche qu'A L'INTERIEUR d'un tick.
 *
 * ⚠️ **Quand la borne du tick est atteinte, le second element se contente de
 * remplacer le premier.** Il n'y a pas de troisieme comportement : ni file
 * d'attente, ni reaction reportee au tick suivant. Une reaction differee
 * s'appliquerait a des positions qui ont bouge, et une file croitrait avec la
 * densite de la horde.
 */
function applyElement(
  horde: Horde,
  reactions: Reactions | undefined,
  slot: number,
  element: number,
  by: number,
  tick: number,
): void {
  const porte = horde.markAt(slot, tick);
  if (reactions && porte !== ELEMENT.NEUTRE && porte !== element) {
    const declenche = reactions.onEntity(horde.entityIdAt(slot), {
      pair: packElementPair(porte, element),
      x: horde.x[slot] ?? 0,
      y: horde.y[slot] ?? 0,
      markBy: horde.markBy[slot] ?? 0,
      by,
      element,
      entityId: horde.entityIdAt(slot),
    });
    if (declenche) {
      // La marque se consomme : `NEUTRE` n'est pas un cas particulier de la
      // table des elements (voir `shared/elements.ts`), donc la reposer par le
      // chemin normal suffit — pas de second setter a maintenir sur `Horde`.
      horde.applyMark(slot, ELEMENT.NEUTRE, 0, tick);
      return;
    }
  }
  horde.applyMark(slot, element, by, tick);
}

/**
 * L'armure effective au tick `tick` : celle de l'archetype, moins ce que les
 * champs de Supraconduction qui couvrent l'entite lui retirent (tache 7 de
 * l'etape 5b).
 *
 * ⚠️ **Une fonction, pas un etat.** Un etat ecrit devrait voyager ; une
 * derivation ne le doit pas — meme forme qu'`aliveAt` et `slowsAt`
 * (`shared/zones.ts`).
 *
 * ⚠️ **`ZoneField.armorReductionAt` fait le balayage et le maximum ; cette
 * fonction ne fait que la SOUSTRAIRE a l'armure de base, bornee a zero.**
 * Voir le docbloc d'`armorReductionAt` pour la raison du maximum — une
 * DECISION DE JEU, PAS celle, arithmetique, du minimum de
 * `Horde#computeSlow` : l'armure ne voyage pas d'un octet, seul le serveur
 * l'utilise ici, le client n'apprenant les morts que par `DEATHS`.
 *
 * ⚠️ **Bornee a zero, jamais negative.** `MAX_ARMOR`/`capArmor`
 * (`shared/archetypes.ts`) bornent l'armure d'archetype PAR LE HAUT, a la
 * LECTURE de la table ; cette fonction la borne symetriquement PAR LE BAS, a
 * la lecture ICI : un ennemi deja peu blinde ne doit jamais voir `brut x amp
 * x (1 - armure)` depasser `brut x amp`.
 */
export function armureA(horde: Horde, slot: number, zones: ZoneField, tick: number): number {
  const base = archetypeOf(horde.archetype[slot] ?? 0).armor;
  const reduction = zones.armorReductionAt(horde.x[slot] ?? 0, horde.y[slot] ?? 0, tick);
  const armure = Math.max(0, base - reduction);
  // L'aura du chaman se COMBINE a l'armure (elle ne s'additionne pas) : sous
  // l'aura, chaque coup perd encore `SHAMAN_AURA_REDUCTION` de ce qui reste.
  return horde.aura.has(horde.entityIdAt(slot))
    ? 1 - (1 - armure) * (1 - SHAMAN_AURA_REDUCTION)
    : armure;
}

/** Une explosion de kamikaze a resoudre : son centre. */
export interface Blast {
  x: number;
  y: number;
}

/**
 * Les explosions de kamikaze du tick : chacune blesse les MONSTRES dans
 * `KAMIKAZE_RADIUS` (elle ne distingue pas les camps) et les JOUEURS, armure
 * comprise. Rend les identites mortes — `selfIds`, les kamikazes qui se font
 * sauter au contact, en font partie — compactees comme les autres passes, pour
 * rejoindre le lot UNIQUE de morts du tick.
 */
export function resolveBlasts(
  horde: Horde,
  orbs: OrbField,
  blasts: readonly Blast[],
  selfIds: readonly number[],
  players: readonly ContactPlayer[],
  tick: number,
  zones: ZoneField,
): number[] {
  const dead = new Set<number>(selfIds);
  for (const id of selfIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      horde.hp[slot] = 0;
    }
  }
  for (const b of blasts) {
    damageInRadius(horde, b.x, b.y, KAMIKAZE_RADIUS, KAMIKAZE_MONSTER_DAMAGE, zones, tick, dead);
    for (const p of players) {
      if (p.hp > 0 && Math.hypot(p.x - b.x, p.y - b.y) < KAMIKAZE_RADIUS) {
        p.hp = Math.max(0, p.hp - KAMIKAZE_PLAYER_DAMAGE * (1 - (p.armor ?? 0)));
      }
    }
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * **Le seul chemin par lequel un ennemi perd des PV.** Meme raison que
 * `Room#grantCard` pour les cartes : deux formules d'armure divergeraient, et
 * le jour ou elles divergent c'est un test qui manque, pas un bug qui se voit.
 * Trois appelants — le balayage par rayon, le tir direct, la combustion — et
 * aucun `horde.hp[...] -=` ailleurs dans le depot ; un `grep` le verifie.
 *
 * Retire `brut x amp x (1 - armure)` a l'entite du creneau `slot`, et note son
 * identite dans `dead` si elle n'y survit pas.
 *
 * ⚠️ **Les deux facteurs sont DERIVES ICI, jamais passes tout calcules.** Les
 * appelants donnent `zones` et `tick` ; l'amplification (`ZoneField.ampAt`, la
 * Poix de la tache 4) et l'armure effective (`armureA`, la Supraconduction de
 * la tache 7) se lisent dans cette fonction. Les recevoir deja multiplies
 * ferait TROIS lieux de derivation aux trois sites d'appel — exactement ce
 * qu'« un seul chemin » existe pour empecher.
 *
 * ⚠️ **Rien de tout ca ne voyage.** Seul le serveur soustrait des PV (§2 de la
 * spec de l'etape 5a) : le client apprend les morts par `DEATHS`. L'armure et
 * l'amplification echappent donc a la contrainte de replication qui impose au
 * ralentissement de se combiner par un minimum exact — voir `ZoneField.ampAt`,
 * qui separe les deux raisons.
 *
 * ⚠️ **NE TUE PAS**, comme `damageInRadius` : tuer compacte la horde et
 * invaliderait les creneaux de la boucle en cours chez l'appelant. Le `Set`
 * (ou le tableau) se remplit ici, `Horde.kill` reste dehors, apres tous les
 * degats.
 *
 * ⚠️ **`Set<number> | number[]`, et les deux sont deliberes.** Les deux
 * chemins de projectiles dedoublonnent (deux impacts peuvent achever la meme
 * entite au meme tick, et `DEATHS` exige des identites uniques) ; la
 * combustion balaie chaque creneau une fois exactement, et un `Set` n'y
 * apporterait qu'une allocation. Le contrat rendu est le meme : une identite y
 * est notee au plus une fois.
 *
 * ⚠️ **La borne est `<= 0`, et AUCUN TEST NE PEUT la separer de `< 0` sur le
 * chemin de la combustion — c'est arithmetique.** `Horde.hp` est un
 * `Float32Array` et `burnPerTick` vaut 0,1, qui n'y est pas representable :
 * soustraire 0,1 (module par l'armure, qui n'arrange rien) d'une reserve
 * arrondie en simple precision ne peut jamais tomber sur exactement zero. Ce
 * sont les degats ENTIERS des projectiles et des reactions qui tiennent cette
 * borne — et c'est la pietaille LEGERE, dont l'armure est nulle, qui la rend
 * exacte. Dit tel quel plutot que de laisser croire a une borne testee depuis
 * les trois sites.
 */
export function appliquerDegats(
  horde: Horde,
  slot: number,
  brut: number,
  zones: ZoneField,
  tick: number,
  dead: Set<number> | number[],
): void {
  const armure = armureA(horde, slot, zones, tick);
  const amp = zones.ampAt(horde.x[slot] ?? 0, horde.y[slot] ?? 0, tick);
  // ⚠️ **AUCUN arrondi, nulle part sur ce chemin.** `Horde.hp` est un
  // `Float32Array` et la combustion y retire deja 0,1 par tick : rien n'impose
  // un entier, et un `Math.round` glisse ici avalerait l'empilement des
  // passifs de degats exactement comme il a avale celui de l'etape 4 et
  // l'echelle de palier de l'etape 6a.
  const reste = (horde.hp[slot] ?? 0) - brut * amp * (1 - armure);
  horde.hp[slot] = reste;
  if (reste <= 0) {
    const id = horde.entityIdAt(slot);
    if (Array.isArray(dead)) {
      dead.push(id);
    } else {
      dead.add(id);
    }
  }
}

/**
 * **LE balayage par rayon, et il n'y en a qu'un.** Retire `damage` a tout
 * ennemi dont le centre tombe a moins de `radius` de `(cx, cy)` — et, quand
 * `markFilter` est fourni, dont la marque COURANTE vaut exactement cette
 * valeur — puis note dans `dead` l'identite de ceux qui n'y survivent pas.
 *
 * ⚠️ **TROIS appelants, un seul balayage** : la reaction elementaire
 * generique (§6.1 de l'etape 5a, `REACTION_DAMAGE` dans `REACTION_RADIUS`),
 * l'explosion d'une arme de zone (tache 16, `Weapon.blastRadius`), et
 * l'Embrasement (Braise + Poix, tache 6 de l'etape 5b, `markFilter =
 * ELEMENT.POIX`). Trois REGLES differentes — deux naissent d'un couple
 * d'elements, une d'un impact — mais une seule GEOMETRIE, et un second
 * balayage ecrit a cote du premier divergerait a la premiere retouche.
 * C'est le motif « deux sources de verite » que ce depot a rencontre quatre
 * fois.
 *
 * ⚠️ **Fusionnee a la revue finale de l'etape 5b (B4).** La tache 6 avait
 * quand meme ECRIT ce second balayage (`damagePoisonedInRadius`) — exactement
 * ce que ce docbloc denonce dix lignes plus haut : meme signature a huit
 * parametres, meme corps, une seule ligne de filtre en plus. Le filtre
 * devient ici un NEUVIEME parametre OPTIONNEL plutot qu'une fonction a part :
 * fusionner les deux, pas retirer la phrase qui l'interdisait — c'est le
 * raisonnement du docbloc lui-meme qui le demande.
 *
 * ⚠️ **Le filtre exclut l'ennemi qui a declenche Embrasement, SANS cas
 * particulier.** Sa marque de Poix vient d'etre consommee par `applyElement`
 * (§4.3, « un ennemi ressort NU d'une reaction ») : `horde.markAt` y rend
 * `NEUTRE`, donc le filtre l'ecarte de lui-meme sans qu'il faille l'exclure
 * explicitement — la geometrie seule n'aurait pas suffi a le faire, la
 * marque, si. Les deux AUTRES appelants ne passent jamais `markFilter` :
 * l'ennemi percute par une explosion, ou l'origine d'une reaction generique,
 * n'ont pas de cas particulier a exclure.
 *
 * ⚠️ **Un rayon, jamais une propagation de proche en proche**, pour
 * Embrasement precisement — ecart assume du §5 de la spec de l'etape 5b :
 * *« se propage a tous les ennemis poisses proches »* se lit comme un
 * parcours de graphe, dont le resultat depend de l'ordre de visite — la
 * meme fragilite que la chaine (`shared/chain.ts`), en pire, puisque rien
 * ici ne departage a distance egale. Une seule passe.
 *
 * ⚠️ **Ne TUE PAS, et c'est ce qui rend le partage possible.** Tuer compacte la
 * horde (`Horde.kill`), donc invaliderait les indices de la boucle qui tourne
 * chez l'appelant — celle de `applyReactions` sur ses declencheurs, celle de
 * `Projectiles.collide` sur ses projectiles. Le `Set` est rempli ici, la
 * compaction reste dehors, apres tous les degats.
 *
 * ⚠️ **La borne est STRICTE (`< radius`)**, comme partout ailleurs dans ce
 * fichier : une entite pile sur le cercle n'est pas touchee. C'est le meme
 * predicat que `markInZones` et que `ZoneField.slowsAt`.
 */
function damageInRadius(
  horde: Horde,
  cx: number,
  cy: number,
  radius: number,
  damage: number,
  zones: ZoneField,
  tick: number,
  dead: Set<number>,
  markFilter?: number,
): void {
  const r2 = radius * radius;
  for (let i = 0; i < horde.count; i++) {
    if (markFilter !== undefined && horde.markAt(i, tick) !== markFilter) {
      continue;
    }
    const dx = (horde.x[i] ?? 0) - cx;
    const dy = (horde.y[i] ?? 0) - cy;
    if (dx * dx + dy * dy >= r2) {
      continue;
    }
    // ⚠️ **L'amplification est PAR ENTITE, pas par point d'impact.** Deux
    // ennemis du meme rayon, l'un dans une flaque et l'autre a cote, ne
    // subissent pas la meme chose — c'est `appliquerDegats` qui lit la
    // position de CHACUN. Deriver le facteur une fois pour le centre du
    // balayage serait plus rapide et faux.
    appliquerDegats(horde, i, damage, zones, tick, dead);
  }
}

/**
 * Court-circuit (Foudre + Poix, tache 6 de l'etape 5b) : `chainTargets`
 * (`shared/chain.ts`, tache 2) sur la seule population POISSEE — **reutilise
 * la meme fonction que la chaine de Foudre, elle n'est pas reecrite.**
 *
 * ⚠️ **Corrige a la revue de la tache 6, apres deux defauts MESURES en
 * execution sur le premier jet (un `break` sur le premier maillon non
 * poisse, `jumps = horde.count`) :**
 *
 * | Defaut mesure | Consequence | Parade |
 * | --- | --- | --- |
 * | `chainTargets` choisit le plus proche NON TOUCHE, poisse ou non | en horde dense, le voisin le plus proche d'un saut est presque toujours SAIN : la chaine s'arretait donc au premier maillon, et « sans limite de sauts » devenait lettre morte | pre-remplir `exclude` avec tous les non-poisses : chaque candidat qu'elle rend est alors poisse PAR CONSTRUCTION, jamais par un filtre a posteriori |
 * | `jumps = horde.count` fait construire la liste ENTIERE avant que quoi que ce soit ne s'arrete | 12,90 ms mesures a N = 1 000, contre un budget de tick de ~11 ms — un seul Court-circuit fait sauter le budget | `COURT_CIRCUIT_MAX_JUMPS`, un plafond DUR de COUT, pas une regle de jeu (voir sa doc, `shared/constants.ts`) |
 *
 * Les deux parades resolvent aussi la lecture de « tant que les cibles sont
 * poissees » (§5 de la spec) : la chaine ne s'arrete plus SUR un maillon
 * sain, elle ne le voit tout simplement jamais — elle saute PAR-DESSUS,
 * directement au poisse suivant, exactement comme un court-circuit reel
 * ignore ce qui ne conduit pas.
 *
 * ⚠️ **Exclut aussi `t.entityId` (l'ennemi qui declenche) et `dead`**, meme
 * raisonnement que le chainage de la Foudre dans `resolveProjectileDamage` —
 * et PAS redondant avec le filtre « non poisse » ci-dessus, malgre les
 * apparences. Un ennemi qui vient de reagir ressort NU (§4.3, `applyElement`
 * remet sa marque a NEUTRE), donc le filtre l'exclurait deja... SAUF s'il est
 * ensuite RE-marque Poix par `markInZones` plus tard dans le MEME tick — un
 * ennemi touche par un PROJECTILE de Foudre reagit dans
 * `resolveProjectileDamage`, qui tourne AVANT `markInZones` (voir l'en-tete de
 * `Room.step`) : s'il se tient aussi dans une flaque de Poix, il ressort
 * marque Poix a nouveau avant que ce declencheur-ci ne soit resolu. Sans
 * l'exclusion explicite, il relancerait sa propre chaine sur lui-meme.
 */
function chainWhilePoisoned(
  horde: Horde,
  trigger: ReactionTrigger,
  damage: number,
  zones: ZoneField,
  tick: number,
  dead: Set<number>,
): void {
  const exclude = new Set(dead);
  // ⚠️ **La garde `!== undefined` est INERTE a l'execution, et AUCUN TEST NE
  // PEUT le separer — mesure par mutation, elle survit.** `Set<number>` est
  // une garantie de TYPE, pas d'execution : ajouter `undefined` au `Set`
  // JavaScript sous-jacent ne fait jamais correspondre `touched.has(id)`,
  // puisque `id` vient toujours de `horde.entityIdAt`, jamais de nulle part
  // ailleurs. Gardee pour la lisibilite du type et pour le jour ou
  // `chainTargets` changerait de contrat, dit tel quel plutot que de laisser
  // croire a une garde testee.
  if (trigger.entityId !== undefined) {
    exclude.add(trigger.entityId);
  }
  // ⚠️ **Le pre-remplissage qui rend chaque saut poisse PAR CONSTRUCTION.**
  // `chainTargets` ne choisit jamais parmi les identites de `exclude` : en y
  // mettant tous les non-poisses AVANT de l'appeler, la fonction ne peut plus
  // rendre qu'une identite poissee, dans l'ordre du plus proche — jamais un
  // badaud qui romprait la chaine par sa seule proximite.
  for (let i = 0; i < horde.count; i++) {
    if (horde.markAt(i, tick) !== ELEMENT.POIX) {
      exclude.add(horde.entityIdAt(i));
    }
  }
  // ⚠️ **`COURT_CIRCUIT_MAX_JUMPS`, jamais `horde.count`.** Une borne de COUT
  // — voir sa doc dans `shared/constants.ts` — pas une regle de jeu : la
  // chaine s'arrete de toute facon des qu'aucun poisse ne reste a portee (voir
  // `chainTargets`), ce plafond ne coupe qu'un cas devenu improbable une fois
  // la population filtree, mais borne le pire cas plutot que de le laisser
  // ouvert.
  const jumps = Math.min(horde.count, COURT_CIRCUIT_MAX_JUMPS);
  for (const id of chainTargets(horde, trigger.x, trigger.y, CHAIN_RADIUS, jumps, exclude)) {
    const slot = horde.slotOf(id);
    // ⚠️ **INATTEIGNABLE par construction, meme raisonnement que les autres
    // `slot < 0` de ce fichier** : `chainTargets` ne rend que des identites
    // lues DANS `horde`, et rien ne compacte entre cet appel et cette boucle.
    if (slot < 0) {
      continue;
    }
    // ⚠️ **Pas de controle `markAt` ici, et c'est delibere.** Le
    // pre-remplissage ci-dessus garantit deja que `id` est poisse — le
    // relire ici testerait une invariante que la boucle du dessus vient
    // d'etablir, jamais une condition qui peut varier PENDANT cette boucle
    // (les marques ne changent pas au fil d'un seul appel synchrone).
    appliquerDegats(horde, slot, damage, zones, tick, dead);
  }
}

/**
 * Paratonnerre (Foudre + Vif-argent, tache 5 de l'etape 5c) : `chainTargets`
 * (`shared/chain.ts`, tache 2) — **inchangee, reutilisee telle quelle** — sur
 * la population LIEE au declencheur, exactement la meme forme que
 * `chainWhilePoisoned` ci-dessus pour Court-circuit : `exclude` pre-rempli de
 * tout ce qui n'est PAS lie, si bien que chaque cible que `chainTargets` peut
 * encore rendre est liee PAR CONSTRUCTION, jamais par un filtre a posteriori.
 *
 * ⚠️ **`CHAIN_JUMPS`/`CHAIN_RADIUS`, jamais `COURT_CIRCUIT_MAX_JUMPS`.**
 * Paratonnerre reste la chaine de Foudre ORDINAIRE (3 sauts) qui PREFERE les
 * ennemis lies — le §5 de la spec de l'etape 5c ne demande ni une
 * propagation sans limite ni un rayon elargi, seulement une PREFERENCE de
 * cible. `jumps` est deja petit : un plafond de cout dedie n'a rien a borner
 * ici, contrairement a Court-circuit ou `jumps = horde.count` risquait de
 * construire la liste entiere avant que quoi que ce soit ne s'arrete.
 *
 * ⚠️ **Le point de revue n°3 du brief : AUCUN ennemi lie.** Sans identite de
 * declencheur, ou si `linkedNeighbours` rend un tableau vide, `linked` reste
 * vide et la boucle ci-dessous ajoute TOUTE la horde a `exclude` — y compris
 * un declencheur qui s'y trouvait deja par construction. `chainTargets` ne
 * trouve alors jamais de candidat (`bestSlot` reste `-1` des le premier tour)
 * et rend une liste VIDE, sans boucler ni lever : degradation gracieuse,
 * meme forme que `chainWhilePoisoned` quand aucun poisse n'est a portee.
 *
 * ⚠️ **La liaison se relit ICI, pas depuis `t` : `ReactionTrigger` ne porte
 * aucun champ « lies ».** Comme pour Vaporisation, `linkedNeighbours` LIT
 * `ReactionDef.zoneVifArgent` (`shared/reactions.ts` — EPINGLE reaction par
 * reaction plutot que derive de la paire, et PARTAGE avec `hitRadiusBonusAt`)
 * — y compris sur la zone que CE MEME declencheur vient de laisser
 * au sol (`postZone`, avant cette fonction) : Paratonnerre porte
 * `zoneVifArgent: true`, donc cette zone LIE elle-meme tout voisin a moins de
 * `ZONE_RADIUS` du point d'impact.
 */
function chainPreferringLinked(
  horde: Horde,
  trigger: ReactionTrigger,
  damage: number,
  zones: ZoneField,
  tick: number,
  dead: Set<number>,
): void {
  const exclude = new Set(dead);
  if (trigger.entityId !== undefined) {
    exclude.add(trigger.entityId);
  }
  const triggerSlot = trigger.entityId !== undefined ? horde.slotOf(trigger.entityId) : -1;
  const linked = new Set(triggerSlot >= 0 ? linkedNeighbours(horde, triggerSlot, zones, tick) : []);
  // ⚠️ **Le pre-remplissage qui rend chaque saut LIE PAR CONSTRUCTION.**
  // `chainTargets` ne choisit jamais parmi les identites de `exclude` : en y
  // mettant tous les non-lies AVANT de l'appeler, la fonction ne peut plus
  // rendre qu'une identite liee, dans l'ordre du plus proche.
  for (let i = 0; i < horde.count; i++) {
    const id = horde.entityIdAt(i);
    if (!linked.has(id)) {
      exclude.add(id);
    }
  }
  for (const id of chainTargets(horde, trigger.x, trigger.y, CHAIN_RADIUS, CHAIN_JUMPS, exclude)) {
    const slot = horde.slotOf(id);
    // ⚠️ INATTEIGNABLE par construction, meme raisonnement que les autres
    // `slot < 0` de ce fichier : `chainTargets` ne rend que des identites
    // lues DANS `horde`, et rien ne compacte entre cet appel et cette boucle.
    if (slot < 0) {
      continue;
    }
    appliquerDegats(horde, slot, damage, zones, tick, dead);
  }
}

/**
 * Amalgame (Poix + Vif-argent, tache 7 de l'etape 5c) : « les degats subis
 * par un ennemi lie frappent aussi ses voisins » (§5 de la spec) — frappe
 * l'ennemi qui declenche, PUIS chacun de ses voisins LIES
 * (`linkedNeighbours`, tache 3), avec le MEME degat, une fois chacun.
 *
 * ⚠️ **La SEULE reaction structurellement neuve de l'etape — ni zone, ni
 * geometrie, ni `chainTargets`.** Vaporisation (Braise + Vif-argent) balaie
 * un RAYON autour de chaque lie (`damageInRadius`) ; Paratonnerre (Foudre +
 * Vif-argent) fait sauter une CHAINE en preferant les lies
 * (`chainTargets`). Amalgame ne fait ni l'un ni l'autre : `linkedNeighbours`
 * EST toute sa geometrie, elle ne balaie jamais un second cercle ni ne
 * construit de chaine par-dessus — un appel direct a `appliquerDegats` par
 * voisin trouve, rien de plus.
 *
 * ⚠️ **UN SEUL niveau, JAMAIS une cascade — la garde tient par CONSTRUCTION,
 * pas par un compteur ou un `Set` de « deja touches ».** Cette fonction
 * n'appelle jamais ELLE-MEME sur un voisin : chaque voisin recoit
 * `appliquerDegats` directement, qui ne consulte aucune liaison. Si A est lie
 * a B et B est lie a C (mais pas A a C), un coup sur A (le declencheur)
 * fait chercher les voisins de A UNE fois (rend B), jamais les voisins de B —
 * C ne recoit donc rien. Voir le test « Amalgame ne se propage pas en
 * cascade », `combat.test.ts`.
 *
 * ⚠️ **`appliquerDegats` elle-meme reste INCHANGEE — voir son docbloc, « le
 * SEUL chemin par lequel un ennemi perd des PV ».** Une variante qui aurait
 * fait cascader `appliquerDegats` elle-meme (pour que N'IMPORTE QUEL degat a
 * un lie se partage, pas seulement celui d'Amalgame) romprait des tests DEJA
 * verts : la Vaporisation ci-dessus balaie deja un rayon centre sur CHAQUE
 * lie, donc le declencheur et son lie retombent chacun dans le rayon de
 * l'autre — un `appliquerDegats` qui cascaderait lui-meme les compterait
 * DEUX FOIS chacun (le coup direct du balayage, PLUS le partage automatique),
 * cassant l'egalite exacte que son test mesure deja. La portee reste donc
 * celle d'UNE reaction precise (Amalgame), jamais une propriete globale du
 * chemin de degats.
 *
 * ⚠️ **La liaison peut venir de n'importe quelle zone dont la reaction
 * porte `zoneVifArgent: true` — y compris celle que CETTE reaction vient de
 * laisser au sol, meme raison que Vaporisation et Paratonnerre.**
 * `linkedNeighbours` lit `ReactionDef.zoneVifArgent` (`shared/reactions.ts` —
 * epingle reaction par reaction, pas derive de la paire) : Amalgame porte
 * `zoneVifArgent: true`, donc la zone qu'elle pose (`postZone`, avant cette
 * fonction) LIE elle-meme tout voisin a moins de `ZONE_RADIUS` du point
 * d'impact — voir le test dedie dans `combat.test.ts`.
 *
 * ⚠️ **Sans identite de declencheur, aucun degat** — meme degradation
 * gracieuse que Vaporisation (un declencheur ne d'un recouvrement de zones,
 * `onZoneCreated`, n'a pas d'ennemi associe).
 *
 * ⚠️ **`dead` est le MEME `Set` que celui d'`applyReactions`, jamais un
 * second lot** : deux lies qui meurent tous les deux du meme Amalgame n'y
 * figurent chacun qu'UNE fois — `Set.add` dedoublonne, `appliquerDegats` ne
 * fait jamais qu'y ajouter une identite. Voir le test « deux ennemis lies qui
 * meurent du meme Amalgame ne comptent qu'une fois chacun ».
 */
function shareAmalgameDamage(
  horde: Horde,
  trigger: ReactionTrigger,
  damage: number,
  zones: ZoneField,
  tick: number,
  dead: Set<number>,
): void {
  const slot = trigger.entityId !== undefined ? horde.slotOf(trigger.entityId) : -1;
  if (slot < 0) {
    return;
  }
  appliquerDegats(horde, slot, damage, zones, tick, dead);
  for (const linkedId of linkedNeighbours(horde, slot, zones, tick)) {
    const linkedSlot = horde.slotOf(linkedId);
    // ⚠️ INATTEIGNABLE par construction, meme raisonnement que les autres
    // `slot < 0` de ce fichier : `linkedNeighbours` ne rend que des identites
    // lues DANS `horde`, et rien ne compacte entre cet appel et cette boucle.
    if (linkedSlot < 0) {
      continue;
    }
    // Un seul appel direct — JAMAIS `shareAmalgameDamage` a nouveau : voir le
    // docbloc ci-dessus, « UN SEUL niveau ».
    appliquerDegats(horde, linkedSlot, damage, zones, tick, dead);
  }
}

/**
 * Resout les reactions collectees pendant le tick : l'effet SPECIFIQUE de la
 * table des reactions (`shared/reactions.ts`, tache 6 de l'etape 5b) si la
 * paire en a un, sinon `REACTION_DAMAGE` a tout ennemi dans `REACTION_RADIUS`
 * du point (le Choc thermique generique de l'etape 5a) — et rend les
 * identites de ceux qui en meurent.
 *
 * ⚠️ **Un lookup dans la table, jamais un `switch` sur `pair`.** Meme motif
 * que `ELEMENT_DEFS`/`WEAPONS`/`ARCHETYPES` : `reactionForPair` est le SEUL
 * endroit qui connaisse la valeur numerique d'un couple d'elements ; cette
 * fonction ne branche que sur le petit identifiant qu'il rend
 * (`ReactionDef.id`), jamais sur la paire elle-meme.
 *
 * ⚠️ **Les morts passent par le `DEATHS` EXISTANT, jamais par un chemin
 * parallele** — meme contrainte que les brulures de la tache 6, et pour la
 * meme raison : `GameClient#drainPendingDeaths` suppose un seul lot par tick,
 * et deux lots rejoues l'un apres l'autre effaceraient la correction du
 * premier. C'est `Room.step` qui FUSIONNE ces identites avec celles des
 * projectiles et des brulures.
 *
 * ⚠️ **Tous les degats d'abord, la compaction ensuite.** Tuer entre deux
 * reactions deplacerait les entites dans les creneaux liberes, et la seconde
 * reaction frapperait des voisins choisis par l'ordre du tableau plutot que
 * par la geometrie. Le `Set` dedoublonne pour la meme raison qu'ailleurs :
 * deux reactions qui achevent le meme ennemi ne doivent pas lister son
 * identite deux fois dans `DEATHS`.
 *
 * L'ennemi qui a declenche la reaction n'a pas de traitement a part : il est a
 * distance nulle du point, donc dans le rayon, donc touche comme les autres.
 *
 * ⚠️ **Et c'est ICI que la reaction laisse son champ au sol** (§5.1, tache
 * 21) : *« un projectile marque, un second element declenche, la reaction
 * laisse un champ »*. Le sol a cesse d'etre l'effet d'un tir pour devenir la
 * trace d'une combinaison — voir `postZone`.
 *
 * ⚠️ **`zones` et `reactions` ne sont PAS optionnels**, contrairement au
 * `zones` que `resolveProjectileDamage` portait avant cette tache. Il n'existe
 * aucun appelant legitime qui resoudrait une reaction sans laisser son champ
 * (ce serait la tache 21 desactivee en silence), ni qui poserait une zone sans
 * arbitrer le couple qu'elle forme avec ses voisines (le §6.2, troisieme
 * ligne). Meme choix que le `reactions` de `markInZones`.
 *
 * ⚠️ **Les champs se posent AVANT les degats, et tous avant le premier.** Deux
 * reactions du meme tick a quelques pixels l'une de l'autre doivent voir la
 * meme reserve de zones que si elles etaient seules — c'est la regle de fusion
 * qui decide, et elle a besoin de l'etat complet. Les degats, eux, ne
 * s'interessent pas aux zones.
 */
export function applyReactions(
  horde: Horde,
  orbs: OrbField,
  tick: number,
  triggers: readonly ReactionTrigger[],
  zones: ZoneField,
  reactions: Reactions,
): number[] {
  for (const t of triggers) {
    postZone(zones, t, tick, reactions);
  }

  const dead = new Set<number>();
  for (const t of triggers) {
    const def = reactionForPair(t.pair);
    if (def?.id === REACTION.EMBRASEMENT) {
      // ⚠️ **Fusionnee avec `damageInRadius` a la revue finale de l'etape 5b
      // (B4) : `damagePoisonedInRadius` n'existe plus, voir le docbloc de
      // `damageInRadius`.** `markFilter = ELEMENT.POIX` reproduit exactement
      // son comportement.
      damageInRadius(horde, t.x, t.y, def.radius, def.damage, zones, tick, dead, ELEMENT.POIX);
    } else if (def?.id === REACTION.COURT_CIRCUIT) {
      // ⚠️ **`def.damage` vaut ICI `REACTION_DAMAGE`, decision assumee de
      // `shared/reactions.ts` : Court-circuit reutilise le degat generique,
      // par saut, faute de raison de jeu d'en choisir un autre.** Ca ne
      // dispense pas de garder la LECTURE : `combat.test.ts` asserte la
      // perte de PV exacte (`def.damage * 3` au site d'appel y a ete mesure
      // et tue, revue de la tache 6) — une egalite de VALEUR n'exempte jamais
      // de garder le CHEMIN qui la lit.
      chainWhilePoisoned(horde, t, def.damage, zones, tick, dead);
    } else if (def?.id === REACTION.ECLAT_DE_GEL) {
      // ⚠️ **Une SEULE cible, jamais un balayage** — `def.radius` vaut 0
      // (voir son docbloc dans `shared/reactions.ts`) : `damageInRadius`
      // avec un rayon nul ne toucherait personne, meme pas le centre (borne
      // STRICTE `< radius`). La cible est l'ennemi qui declenche
      // (`t.entityId`), retrouve par `Horde.slotOf` comme partout ailleurs
      // dans ce fichier — jamais `damageInRadius`, donc un second chemin
      // n'existe pas : `appliquerDegats` reste l'UNIQUE porte de sortie des
      // PV.
      //
      // ⚠️ **`t.entityId` peut etre absent** — un declencheur ne d'un
      // recouvrement de zones (`onZoneCreated`) n'a pas d'ennemi associe
      // (voir le docbloc de `ReactionTrigger.entityId`). Sans cible, Eclat de
      // gel ne fait rien : il n'y a personne « sur qui » masser des degats
      // bruts, contrairement a Embrasement/Court-circuit dont l'effet reste
      // geometrique ou en chaine meme sans identite de declencheur.
      const slot = t.entityId !== undefined ? horde.slotOf(t.entityId) : -1;
      if (slot >= 0) {
        appliquerDegats(horde, slot, def.damage, zones, tick, dead);
      }
    } else if (def?.id === REACTION.VAPORISATION) {
      // ⚠️ **Vaporisation (Braise + Vif-argent) : degats en RAYON autour de
      // CHAQUE ennemi LIE au declencheur — §5 de la spec, « porte par la
      // geometrie », pas par une zone.** Reutilise `damageInRadius` (le SEUL
      // balayage par rayon) et `linkedNeighbours` (tache 2) sans en reecrire
      // une seconde forme de chacune.
      //
      // ⚠️ **Aucun `markFilter` passe ici, deliberement.** Chaque centre est
      // deja un ennemi SELECTIONNE par la geometrie de la liaison ; filtrer
      // en plus par la marque exclurait a tort le declencheur lui-meme
      // (§4.3, il ressort NU) des rayons de ses propres lies qui le
      // recouvrent.
      //
      // ⚠️ **Sans identite de declencheur, aucun degat — Vaporisation ne
      // retombe PAS sur le point d'origine.** Mais avec une identite, la
      // zone que `postZone` vient de poser POUR CE declencheur (juste
      // au-dessus, premiere boucle d'`applyReactions`) suffit a elle seule
      // a lier : `linkedNeighbours` lit `ReactionDef.zoneVifArgent` (`shared/
      // reactions.ts` — epingle reaction par reaction, pas derive de la
      // paire), et Vaporisation porte `zoneVifArgent: true`. Aucune autre zone
      // n'est donc requise pour qu'un voisin a moins de `ZONE_RADIUS` du
      // point d'impact soit lie.
      const slot = t.entityId !== undefined ? horde.slotOf(t.entityId) : -1;
      if (slot >= 0) {
        for (const linkedId of linkedNeighbours(horde, slot, zones, tick)) {
          const linkedSlot = horde.slotOf(linkedId);
          // ⚠️ INATTEIGNABLE par construction, meme raisonnement que les
          // autres `slot < 0` de ce fichier.
          if (linkedSlot < 0) {
            continue;
          }
          damageInRadius(
            horde,
            horde.x[linkedSlot] ?? 0,
            horde.y[linkedSlot] ?? 0,
            def.radius,
            def.damage,
            zones,
            tick,
            dead,
          );
        }
      }
    } else if (def?.id === REACTION.ARC_CAUSTIQUE) {
      // ⚠️ **Arc caustique (Foudre + Chaux) : `chainTargets` INCHANGEE,
      // meme forme que la chaine de Foudre ordinaire, PLUS une pose de zone
      // corrosive a CHAQUE cible touchee** (§5 : « la chaine laisse un champ
      // corrosif a chaque saut »). `postZone` reste le SEUL createur de
      // zones : rappelee ici a la position de chaque maillon, jamais un
      // second chemin de creation.
      const exclude = new Set(dead);
      if (t.entityId !== undefined) {
        exclude.add(t.entityId);
      }
      for (const id of chainTargets(horde, t.x, t.y, CHAIN_RADIUS, CHAIN_JUMPS, exclude)) {
        const slot = horde.slotOf(id);
        if (slot < 0) {
          continue;
        }
        appliquerDegats(horde, slot, def.damage, zones, tick, dead);
        // Le champ corrosif SUIT la cible, pas le point d'impact d'origine —
        // le declencheur `t` porte deja le bon couple/element, seule la
        // position change.
        postZone(zones, { ...t, x: horde.x[slot] ?? 0, y: horde.y[slot] ?? 0 }, tick, reactions);
      }
    } else if (def?.id === REACTION.PARATONNERRE) {
      // Paratonnerre (Foudre + Vif-argent) : voir `chainPreferringLinked`
      // ci-dessus pour la forme complete (`exclude` pre-rempli des non-lies).
      chainPreferringLinked(horde, t, def.damage, zones, tick, dead);
    } else if (def?.id === REACTION.AMALGAME) {
      // Amalgame (Poix + Vif-argent) : voir `shareAmalgameDamage` ci-dessus
      // pour la forme complete (un seul niveau, aucune cascade).
      shareAmalgameDamage(horde, t, def.damage, zones, tick, dead);
    } else {
      damageInRadius(horde, t.x, t.y, REACTION_RADIUS, REACTION_DAMAGE, zones, tick, dead);
    }
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Etape 8 de la sequence serveur : avance les projectiles, resout les
 * collisions, tue les entites touchees et fait apparaitre leurs orbes — dans
 * cet ordre, pour que la position capturee par l'orbe soit encore celle du
 * monstre AVANT sa compaction par `Horde.kill`. Rend les identites mortes ce
 * tick (pour le message DEATHS).
 *
 * ⚠️ **Le `Set` de deduplication reste indispensable, pour une raison qui a
 * CHANGE a l'etape 5a.** Il ne protege plus contre « deux projectiles tuent le
 * meme ennemi au meme tick » — avec des PV, le second impact ne « tue » plus,
 * il descend une reserve deja a zero. Il protege contre le fait que la MEME
 * identite soit listee deux fois dans le lot : deux projectiles qui achevent
 * la meme entite au meme tick passent tous les deux par `reste <= 0`, et sans
 * le `Set` l'identite partirait deux fois dans `DEATHS` — ce que le §3.1 de la
 * spec de l'etape 3 interdit (« triees en ordre croissant » suppose des
 * identites uniques) et que `Horde.kill` ne fait que tolerer defensivement
 * (voir sa doc, et le doublon y supprimerait l'entite VIVANTE deplacee dans le
 * creneau). Le `Set` rend cette garantie structurelle plutot que defensive.
 *
 * ⚠️ **Un projectile ne touche plus forcement UNE entite** (tache 16, sur
 * retour de jeu : *« il faut parfois des AoE sur certaines armes comme les
 * grenades »*). Une arme dont `blastRadius` est non nul frappe tout ce qui
 * entoure l'ennemi percute, par `damageInRadius` — LE balayage par rayon, celui
 * que la reaction elementaire utilise deja. Le `Set` en devient d'autant plus
 * necessaire : une explosion et un tir suivant peuvent achever la meme entite
 * dans le meme `collide`.
 *
 * ⚠️ **L'explosion ne MARQUE que l'ennemi percute**, pas le rayon. Poser
 * l'element sur tout le rayon ferait de chaque grenade un declencheur de masse
 * — la borne du §6.2 est par ennemi et par tick, elle ne borne donc rien contre
 * ca — et la Braise de la grenade cesserait d'etre un choix de placement pour
 * devenir un effet de surface. Signale, pas tranche ici : c'est du contenu.
 *
 * ⚠️ **La Foudre (etape 5b, tache 3) chaine depuis l'ennemi PERCUTE, pas
 * depuis le rayon d'une explosion.** Une fois l'element reconnu et la marque
 * posee (`applyElement`), `ELEMENT.FOUDRE` declenche `chainTargets` a son
 * tour : chaque cible qu'elle rend recoit `appliquerDegats`, donc l'armure et
 * l'amplification de zone comme n'importe quel autre coup — aucun second
 * chemin de degats. Rien de nouveau ne voyage : les morts de la chaine
 * rejoignent le `dead` EXISTANT, donc le `DEATHS` de ce meme tick.
 */
export function resolveProjectileDamage(
  projectiles: Projectiles,
  dt: number,
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
  reactions?: Reactions,
): number[] {
  // ⚠️ **Un projectile ne laisse plus RIEN au sol** (tache 21). Il posait une
  // zone a ses DEUX fins de course — la vieillesse dans `step`, l'impact dans
  // `collide` — et les deux sont parties ensemble, avec le parametre `zones`
  // et le rappel `onExpire` de `Projectiles.step` qui n'existait que pour la
  // premiere. Ce qui reste au projectile, c'est de MARQUER ce qu'il touche :
  // le seul chemin qui mene a la premiere reaction, donc au premier champ.
  const dead = new Set<number>();
  // ⚠️ **Le souffle part AUSSI en fin de course** (etape 8) : *« la grenade
  // doit exploser en fin de course meme si elle touche personne »*. Jusqu'ici
  // une arme de zone qui n'avait percute personne disparaissait sans rien
  // faire — ce qui est juste pour un trait, et faux pour une bombe.
  //
  // ⚠️ **Le meme balayage qu'a l'impact** (`damageInRadius`), au point ou le
  // projectile s'eteint : il n'y a pas deux explosions dans ce fichier, il y
  // en a une, atteinte par deux chemins.
  //
  // ⚠️ **Rien pour les armes SANS souffle** : seize sur dix-sept finissent leur
  // course sans rien laisser, et c'est la ligne absente qui reste le cas
  // courant.
  projectiles.step(dt, (slot) => {
    const souffle = projectiles.blastRadiusAt(slot);
    if (souffle <= 0) {
      return;
    }
    damageInRadius(
      horde,
      projectiles.x[slot] ?? 0,
      projectiles.y[slot] ?? 0,
      souffle,
      projectiles.damageAt(slot),
      zones,
      tick,
      dead,
    );
  });

  // ⚠️ **`zones, tick` en dernier : le rayon de touche elargi du Vif-argent
  // (etape 5c, tache 3), COTE SERVEUR SEUL.** Voir `ZoneField.hitRadiusBonusAt`
  // (`shared/zones.ts`) et le docbloc de `Projectiles.collide`
  // (`shared/projectiles.ts`) — le client (`front/src/net/client.ts`) appelle
  // `collide` sans ces deux arguments pour ses projectiles cosmetiques, et
  // garde donc le rayon de base.
  projectiles.collide(
    horde,
    (entityId, damage, projectileSlot) => {
      const element = projectiles.elementAt(projectileSlot);
      const by = projectiles.ownerAt(projectileSlot);
      const slot = horde.slotOf(entityId);
      if (slot < 0) {
        // ⚠️ **INATTEIGNABLE par construction, et AUCUN TEST NE LA GARDE.**
        // `collide` ne rend que des identites lues dans la horde elle-meme, et
        // rien ne compacte entre les deux : la seule compaction est le
        // `horde.kill` final, plus bas. La mutation « remplacer cette condition
        // par `false` » survit donc a toute la suite — verifie par application,
        // pas raisonne.
        //
        // Gardee quand meme, et dit tel quel plutot que de laisser croire a une
        // garde testee (meme choix qu'a R10 de l'etape 4) : sans elle,
        // `horde.hp[-1] = ...` est un no-op SILENCIEUX sur un tableau type —
        // des degats qui disparaissent sans trace le jour ou un appelant futur
        // compacterait entre `collide` et ce rappel.
        return;
      }
      // Le neutre amplifie ce que l'equipe a marque (`NEUTRE_MARQUE_AMP`). Lu
      // AVANT les degats : la marque est celle que le tir trouve en arrivant.
      const coup =
        element === ELEMENT.NEUTRE && horde.markAt(slot, tick) !== ELEMENT.NEUTRE
          ? damage * NEUTRE_MARQUE_AMP
          : damage;
      const blastRadius = projectiles.blastRadiusAt(projectileSlot);
      if (blastRadius > 0) {
        // ⚠️ **L'arme de zone passe par LE balayage commun** (tache 16), celui
        // que la reaction elementaire utilise depuis l'etape 5a. Le centre est
        // l'ennemi PERCUTE, pas la position du projectile : `collide` teste le
        // segment parcouru pendant le pas, donc le projectile peut avoir
        // depasse sa cible d'une dizaine de pixels au moment ou il la touche.
        // L'explosion appartient a l'impact, pas au point d'arrivee.
        //
        // ⚠️ **L'ennemi percute n'a PAS de traitement a part** : il est a
        // distance nulle du centre, donc dans le rayon, donc touche comme les
        // autres — exactement le raisonnement de `applyReactions`. Lui retirer
        // `damage` une seconde fois ici lui infligerait le double du reste de la
        // horde.
        damageInRadius(
          horde,
          horde.x[slot] ?? 0,
          horde.y[slot] ?? 0,
          blastRadius,
          coup,
          zones,
          tick,
          dead,
        );
      } else {
        // ⚠️ **Le tir simple garde son chemin DIRECT, et c'est une question de
        // cout, pas de regle.** `damageInRadius` est en O(horde) par impact ; le
        // lance-flammes pose 18 projectiles par seconde et par joueur, et huit
        // armes sur neuf ne sont pas des armes de zone. Un balayage a rayon nul
        // serait la meme regle ecrite plus cher — et il toucherait en prime tout
        // ennemi pile aux memes coordonnees.
        // Le porte-bouclier arrete l'essentiel d'un tir qui le prend DE FACE
        // (le tir remonte sa trajectoire) : il faut le contourner, ou passer par
        // les explosions, les zones et les chaines, que le bouclier ignore.
        const cap = projectiles.headingAt(projectileSlot);
        const deFace =
          archetypeOf(horde.archetype[slot] ?? 0).behavior === 'bouclier' &&
          Math.cos(cap) * (horde.vx[slot] ?? 0) + Math.sin(cap) * (horde.vy[slot] ?? 0) < 0;
        appliquerDegats(horde, slot, deFace ? coup * (1 - SHIELD_BLOCK) : coup, zones, tick, dead);
      }
      if (dead.has(entityId)) {
        // ⚠️ **UN ENNEMI QUI MEURT DU MEME IMPACT N'EST PAS MARQUE.** Un mort ne
        // porte pas d'element : c'est la reaction qui consomme une marque, et il
        // n'y a plus rien a consommer.
        //
        // ⚠️ **`dead.has`, et plus `reste <= 0` : la tache 16 a du le deplacer.**
        // Avec une arme de zone, ce n'est plus la branche du dessus qui prononce
        // la mort de l'ennemi percute — c'est `damageInRadius`, qui la prononce
        // pour tout le rayon d'un coup. La question posee reste la meme (« celui
        // que je m'apprete a marquer est-il mort ? »), mais la reponse ne vit
        // plus dans une variable locale. Elle couvre du meme geste un cas qui
        // existait deja : un ennemi acheve par l'explosion d'un AUTRE projectile
        // du meme tick n'est pas marque non plus.
        //
        // ⚠️ **CE COMMENTAIRE DISAIT « aucun test ne garde ce `return` », ET
        // C'ETAIT FAUX — mesure a la tache 16, mutation appliquee.** Le neutraliser
        // fait rougir « un ennemi qui MEURT du meme impact ne reagit pas »
        // (`combat.test.ts`, tache 7 de l'etape 5a) : sans lui, `applyElement`
        // tourne sur le mourant, y trouve une marque d'un autre element et
        // DECLENCHE une reaction que le §4.3 interdit. Ce qui n'etait pas garde,
        // c'est la consequence que le plan de l'etape 5a annoncait (« la marque
        // serait posee sur une AUTRE entite ») — celle-la est bien impossible :
        // `#removeAt` copie la DERNIERE entite DANS le creneau libere, donc la
        // marque du mourant est ecrasee, jamais heritee. Un garde peut etre tenu
        // par un test tout en ayant ete justifie par une raison inexacte, et
        // c'est le cas ici.
        return;
      }
      if (element !== ELEMENT.NEUTRE) {
        // Le §6.2, premiere ligne : un ennemi deja marque d'un AUTRE element
        // reagit ; marque du MEME, il ne fait que rafraichir. `applyElement`
        // porte les deux cas, exactement comme pour les zones.
        applyElement(horde, reactions, slot, element, by, tick);
        if (element === ELEMENT.FOUDRE) {
          // ⚠️ **La chaine (etape 5b, tache 3) : le seul endroit qui sache
          // qu'il tient une Foudre.** `shared/elements.ts` le dit sur
          // `ELEMENT.FOUDRE` : contrairement a `burnPerTick`/`slowFactor`, la
          // chaine ne se derive pas d'une marque portee par l'entite — elle se
          // derive d'un POINT D'IMPACT, donc c'est ICI, au site qui vient de
          // reconnaitre l'element, qu'elle doit se declencher.
          //
          // ⚠️ **L'exclusion porte DEUX choses.** L'entite PERCUTEE
          // (`entityId`) : sans elle, le premier saut — mesure depuis SA
          // PROPRE position — la retrouverait a distance nulle et la chaine
          // sauterait sur elle-meme. Et `dead` tel quel, sans copie manuelle :
          // la doc de `chainTargets` l'autorise explicitement (« exclude est
          // copie par la fonction, jamais mute : tu peux lui passer ton
          // ensemble de morts sans precaution ») — un voisin deja tue par le
          // souffle de CE MEME projectile (la branche `damageInRadius`
          // au-dessus) ne doit pas recevoir un second coup qu'il ne peut plus
          // propager. Meme principe que « un ennemi qui meurt du meme impact
          // ne propage pas », etendu a un mort plus ancien du meme tick.
          const chainExclude = new Set(dead);
          chainExclude.add(entityId);
          const cx = horde.x[slot] ?? 0;
          const cy = horde.y[slot] ?? 0;
          for (const chainedId of chainTargets(
            horde,
            cx,
            cy,
            CHAIN_RADIUS,
            CHAIN_JUMPS,
            chainExclude,
          )) {
            const chainedSlot = horde.slotOf(chainedId);
            // ⚠️ **INATTEIGNABLE par construction, meme raisonnement que le
            // `slot < 0` plus haut dans cette fonction.** `chainTargets` ne
            // rend que des identites lues DANS `horde` a l'instant de l'appel,
            // et rien ne compacte entre cet appel et la boucle qui suit :
            // `Horde.kill` reste le SEUL compacteur, et il n'arrive qu'a la
            // toute fin de cette fonction. Gardee quand meme, pour la meme
            // raison qu'ailleurs : un `horde.hp[-1] = ...` silencieux sur un
            // tableau type serait des degats qui disparaissent sans trace le
            // jour ou ce n'est plus vrai.
            if (chainedSlot >= 0) {
              appliquerDegats(horde, chainedSlot, damage, zones, tick, dead);
            }
          }
        }
      }
    },
    zones,
    tick,
  );
  if (dead.size === 0) {
    return [];
  }

  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Une pulsation de halo : ce qu'une arme de famille `'halo'` pose au tick ou
 * sa recharge est faite (etape 8).
 *
 * ⚠️ **C'est `Room#fireOne` qui la fabrique, pas cette fonction.** Les
 * reglages (recharge, passifs de cadence et de degats, exemplaires empiles)
 * vivent deja la-bas pour toutes les familles : les recopier ici en ferait une
 * seconde definition de « quand et combien », et les deux finiraient par se
 * contredire. Ce qui arrive ici est deja resolu — un point, un rayon, un
 * degat.
 */
export interface HaloPulse {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly damage: number;
  /** L'element porte par le halo, `ELEMENT.NEUTRE` s'il n'en porte aucun. */
  readonly element: number;
  /** Le joueur a qui ce halo appartient — c'est LUI que la marque retient (§7). */
  readonly by: number;
}

/**
 * Le halo (etape 8) : a chaque pulsation, tout ce qui se tient dans le rayon
 * encaisse.
 *
 * ⚠️ **Le balayage est celui de la GRENADE** (`damageInRadius`, tache 16),
 * deja partage avec la reaction elementaire : un halo est une explosion qui se
 * repete sur le joueur, pas un systeme de plus. Rien de neuf ne decide ici de
 * qui meurt.
 *
 * ⚠️ **Il ne MARQUE que le plus proche, pas tout le rayon — et c'est la regle
 * de l'arme de zone, reprise telle quelle.** Une grenade tue large et ne
 * marque que l'ennemi percute (voir `resolveProjectileDamage`) ; un halo qui
 * marquerait ses quarante ennemis d'un coup declencherait quarante reactions
 * au tick suivant, donc quarante zones — `ZONE_CAPACITY` vaut 128 et le
 * recouvrement est en O(zones²). Le §6.6 veut la reaction RARE ; une arme ne
 * doit pas pouvoir en faire une pluie.
 *
 * ⚠️ **Le plus proche VIVANT.** Marquer un mourant declencherait une reaction
 * sur quelqu'un qui n'est plus la — exactement ce que `resolveProjectileDamage`
 * evite avec son `dead.has(entityId)`.
 *
 * Rend les identites mortes, comme `resolveBurn` et `resolveProjectileDamage`,
 * pour que `Room.step` n'ait qu'une seule facon de prononcer une mort.
 */
export function resolveHalos(
  pulses: readonly HaloPulse[],
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
  reactions?: Reactions,
): number[] {
  if (pulses.length === 0) {
    return [];
  }
  const dead = new Set<number>();
  for (const pulse of pulses) {
    damageInRadius(horde, pulse.x, pulse.y, pulse.radius, pulse.damage, zones, tick, dead);
    if (pulse.element === ELEMENT.NEUTRE || !reactions) {
      continue;
    }
    let bestSlot = -1;
    let bestDist2 = Number.POSITIVE_INFINITY;
    const r2 = pulse.radius * pulse.radius;
    for (let i = 0; i < horde.count; i++) {
      if (dead.has(horde.entityIdAt(i))) {
        continue;
      }
      const dx = (horde.x[i] ?? 0) - pulse.x;
      const dy = (horde.y[i] ?? 0) - pulse.y;
      const d2 = dx * dx + dy * dy;
      // ⚠️ `>=` comme `damageInRadius` : le bord du rayon n'est PAS touche, et
      // la marque ne doit pas aller plus loin que le degat.
      if (d2 >= r2 || d2 >= bestDist2) {
        continue;
      }
      bestDist2 = d2;
      bestSlot = i;
    }
    if (bestSlot >= 0) {
      applyElement(horde, reactions, bestSlot, pulse.element, pulse.by, tick);
    }
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Un trait de faisceau : ce qu'une arme de famille `'faisceau'` pose au tick
 * ou sa recharge est faite (etape 8).
 *
 * Comme `HaloPulse`, il arrive DEJA resolu — `Room#fireOne` a applique la
 * cadence, les passifs et les exemplaires empiles. Ce qui est ici est une
 * geometrie et un degat.
 */
export interface BeamPulse {
  /** L'origine : le joueur. */
  readonly x: number;
  readonly y: number;
  /** L'autre bout du trait, deja derive de la visee et de la portee. */
  readonly toX: number;
  readonly toY: number;
  /** Demi-largeur : ce qui est a moins que ca du segment est fauche. */
  readonly width: number;
  readonly damage: number;
  readonly element: number;
  readonly by: number;
}

/**
 * Le faisceau (etape 8) : tout ce qui touche le trait encaisse, du porteur
 * jusqu'au bout de sa portee.
 *
 * ⚠️ **La geometrie est celle des PROJECTILES**, `distanceToSegmentSquared` —
 * ecrite pour que `collide` teste le segment parcouru pendant un pas plutot
 * que son seul point d'arrivee. Un faisceau est ce meme segment, tenu une
 * image au lieu d'un tick : rien de neuf ne mesure ici.
 *
 * ⚠️ **Il ne MARQUE que le plus proche**, exactement comme le halo et comme
 * l'arme de zone — voir `resolveHalos` pour le raisonnement complet (une
 * reaction par ennemi touche ferait une pluie de zones, que le §6.6 refuse).
 * « Le plus proche » se mesure depuis le PORTEUR, pas depuis le trait : c'est
 * le premier corps que le rayon rencontre.
 */
export function resolveBeams(
  beams: readonly BeamPulse[],
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
  reactions?: Reactions,
): number[] {
  if (beams.length === 0) {
    return [];
  }
  const dead = new Set<number>();
  for (const beam of beams) {
    const w2 = beam.width * beam.width;
    let bestSlot = -1;
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < horde.count; i++) {
      const ex = horde.x[i] ?? 0;
      const ey = horde.y[i] ?? 0;
      if (distanceToSegmentSquared(ex, ey, beam.x, beam.y, beam.toX, beam.toY) >= w2) {
        continue;
      }
      appliquerDegats(horde, i, beam.damage, zones, tick, dead);
      const dx = ex - beam.x;
      const dy = ey - beam.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestDist2 && !dead.has(horde.entityIdAt(i))) {
        bestDist2 = d2;
        bestSlot = i;
      }
    }
    if (bestSlot >= 0 && beam.element !== ELEMENT.NEUTRE && reactions) {
      applyElement(horde, reactions, bestSlot, beam.element, beam.by, tick);
    }
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Etape 9 de la sequence serveur : arbitre le contact entre les joueurs et
 * la horde (§3.4 / §6.3 de la spec) — hitbox genereuse, penchant en faveur
 * du joueur, avec une fenetre d'invulnerabilite apres chaque touche.
 *
 * ⚠️ **`contactInvulnTicks` est ce qui empeche une mort en une seconde.** Sans
 * lui, un joueur plante dans la horde perdrait `CONTACT_DAMAGE` a CHAQUE tick
 * (30 fois par seconde a `TICK_HZ`) au lieu d'une fois tous les
 * `CONTACT_INTERVAL_TICKS` (15, soit 0,5 s) — peu importe le nombre de
 * monstres au contact simultanement : l'invulnerabilite est PAR JOUEUR, pas
 * par paire joueur/monstre.
 *
 * Modifie `players` EN PLACE (hp, contactInvulnTicks) : pas de retour, comme
 * `Horde.step` modifie une `Horde` en place.
 */
export function resolveContact(players: readonly ContactPlayer[], horde: Horde): void {
  const r2 = CONTACT_RADIUS * CONTACT_RADIUS;
  for (const player of players) {
    if (player.hp <= 0) {
      continue;
    }
    if (player.contactInvulnTicks > 0) {
      player.contactInvulnTicks--;
      continue;
    }

    let touched = false;
    for (let i = 0; i < horde.count; i++) {
      const dx = (horde.x[i] ?? 0) - player.x;
      const dy = (horde.y[i] ?? 0) - player.y;
      if (dx * dx + dy * dy <= r2) {
        touched = true;
        break;
      }
    }

    if (touched) {
      player.hp = Math.max(0, player.hp - CONTACT_DAMAGE * (1 - (player.armor ?? 0)));
      player.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
    }
  }
}

/**
 * Un joueur tel que l'arbitrage de la charge le voit : un `ContactPlayer` plus
 * son identite, parce que la charge ne blesse **qu'une fois par joueur et par
 * charge** et qu'il faut donc savoir lesquels ont deja ete touches.
 */
export interface ChargeTarget extends ContactPlayer {
  readonly id: number;
}

/**
 * Applique les degats de la charge du boss au tick `tick`, et rend les
 * identites des joueurs touches CE tick-ci (etape 6a, tache 5 bis).
 *
 * ⚠️ **ARBITRE PAR LE SERVEUR, comme tout ce qui fait mal.** Le client derive
 * la POSITION du boss — c'est ce qui rend la charge replicable a 0,000 px — mais
 * il ne prononce jamais un degat, exactement comme il ne prononce jamais une
 * mort depuis l'etape 3.
 *
 * ⚠️ **RIEN NE FAIT MAL PENDANT LE CHARGEMENT** (§4 de la spec) : `chargeHurtsAt`
 * porte cette regle, et elle est ce qui rend le telegraphe sur — le temps de
 * chargement EST la fenetre de reaction du joueur.
 *
 * ⚠️ **Une seule fois par joueur et par charge**, d'ou `alreadyHit`. Sans cette
 * borne, un joueur immobile dans le couloir encaisserait `BOSS_CHARGE_DAMAGE` a
 * chacun des `BOSS_CHARGE_TICKS` ticks de la traversee, soit dix-huit fois de
 * quoi le tuer : la charge cesserait d'etre une attaque pour devenir une
 * execution. C'est le meme role que `contactInvulnTicks` joue pour le contact
 * ordinaire, avec une borne differente parce que l'evenement est different —
 * une charge est UN evenement, pas une cadence.
 *
 * ⚠️ **Le corps qui blesse est un DISQUE, pas le rectangle annonce.** Le
 * rectangle dit ou le boss VA passer ; ce qui touche, c'est le corps a l'instant
 * `tick`, de diametre `charge.width`. Un joueur qui traverse le couloir derriere
 * le boss n'est pas touche, et c'est la meme regle que tout le reste du jeu —
 * `resolveContact`, `resolvePickups`, `collide` comparent tous une distance a un
 * rayon.
 *
 * ⚠️ **Lit la position dans la HORDE, jamais le point derive tout seul.** Si le
 * boss est mort en pleine charge, il n'est plus dans la horde et la charge cesse
 * de blesser au meme tick que celui ou `Horde#applyCharge` cesse de le deplacer
 * — une seule source de verite pour « le boss est-il encore la ».
 */
export function resolveChargeHit(
  players: readonly ChargeTarget[],
  horde: Horde,
  charge: BossCharge,
  tick: number,
  alreadyHit: ReadonlySet<number>,
): number[] {
  if (!chargeHurtsAt(charge, tick)) {
    return [];
  }
  const slot = horde.slotOf(charge.entityId);
  if (slot < 0) {
    return [];
  }
  const bx = horde.x[slot] ?? 0;
  const by = horde.y[slot] ?? 0;
  const r = charge.width / 2;
  const r2 = r * r;

  const hit: number[] = [];
  for (const player of players) {
    if (player.hp <= 0 || alreadyHit.has(player.id)) {
      continue;
    }
    const dx = bx - player.x;
    const dy = by - player.y;
    if (dx * dx + dy * dy > r2) {
      continue;
    }
    player.hp = Math.max(0, player.hp - BOSS_CHARGE_DAMAGE * (1 - (player.armor ?? 0)));
    // Le corps du boss reste sur lui le temps de le traverser : sans ce
    // rearmement, `resolveContact` lui reprendrait `CONTACT_DAMAGE` au tick
    // suivant pour le meme corps, et la borne « une fois par charge » ne
    // bornerait plus grand-chose.
    player.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
    hit.push(player.id);
  }
  return hit;
}

/**
 * Pose le champ que laisse une reaction, a son point d'application — creation,
 * ou rafraichissement de celui qui couvre deja le point (§5.1 bis, la regle
 * qui BORNE le nombre de zones).
 *
 * ⚠️ **C'est le SEUL createur de zones depuis la tache 21.** Le projectile en
 * posait une a chaque fin de course (modele du §6.3 de l'orientation, « les
 * elements s'appliquent au sol autant qu'aux ennemis ») ; l'auteur a bascule
 * sur celui du §6.4, ou trois reactions sur quinze laissent deja un effet au
 * sol. Consequence de budget mesuree au banc `zones` (quatre joueurs, 1 500
 * pietailles LOURDES, 300 pas) :
 *
 * | Exemplaires par arme | Zones vivantes | Annonces/s/joueur | ko/s par client |
 * | --- | --- | --- | --- |
 * | 1, avant | 27 | 1,9 | 0,08 |
 * | 8, avant | 28 | 1,9 | 0,08 |
 * | 1, apres | **5** | **0,1** | **0,01** |
 * | 8, apres | **3** | **0,1** | **0,01** |
 *
 * Les zones ne naissent plus que d'une combinaison, et les reactions sont
 * bornees a une par ennemi et par tick (§6.2). **Aucune des bornes de l'etape
 * n'est retiree pour autant** — fusion, `ZONE_CAPACITY`,
 * `ZONE_REFRESH_INTERVAL_TICKS` : elles ne coutent rien, et le jour ou une
 * reaction en chaine arrivera (§6.4, *« Court-circuit : la chaine se propage
 * sans limite de sauts »*), elles seront deja la.
 *
 * ⚠️ **Les coordonnees sont ARRONDIES**, exactement comme `Room.step` arrondit
 * les positions de joueurs avant de nourrir son flowfield (constat C1.4 de
 * l'etape 2). Le message `ZONE` ne transporte que des `int16` : le client ne
 * connaitra jamais que la version arrondie. Si le serveur gardait le flottant,
 * les deux cotes compareraient des disques decales d'un demi-pixel — et le
 * predicat `dx² + dy² < ZONE_RADIUS²` du ralentissement rendrait des booleens
 * differents pour les entites pile sur le bord. Le serveur s'impose donc
 * l'arrondi qu'il inflige au client, comme il s'impose deja son retard.
 *
 * ⚠️ **Le garde « element neutre » a ete RETIRE avec le projectile qui le
 * justifiait, mutation a l'appui.** Un declencheur ne nait que d'un element
 * non neutre — `applyElement` exige `porte !== NEUTRE` et `element !== NEUTRE`
 * chez ses deux appelants, `onZoneCreated` ne lit que des elements de zones —
 * et les zones ne naissent plus que d'ici. La recurrence se referme : aucune
 * zone neutre ne peut exister, donc aucun test ne pouvait faire rougir ce
 * garde. Une garde qu'aucun test ne peut faire rougir est une garde qu'on
 * croit avoir.
 */
function postZone(
  zones: ZoneField,
  trigger: ReactionTrigger,
  tick: number,
  reactions: Reactions,
): void {
  // ⚠️ **Le compte AVANT la pose est le seul moyen de distinguer une creation
  // d'un rafraichissement.** `spawn` rend le creneau touche dans les deux cas
  // (c'est ce dont `Room.#announceZones` a besoin), et le §6.2 ne fait reagir
  // deux zones qu'a LA CREATION DE LA SECONDE. Sans cette distinction, deux
  // reactions qui se repetent au meme endroit declencheraient une reaction de
  // recouvrement a chaque fois, indefiniment.
  // ⚠️ **Le nibble de reaction est POSE ICI, depuis la tache 6 de l'etape
  // 5b.** `reactionForPair` cherche `trigger.pair` dans la table des
  // reactions (`shared/reactions.ts`) ; une paire absente (le Choc thermique
  // generique, ou une paire des taches 7/8 pas encore ecrite) rend
  // `undefined`, et `REACTION.AUCUNE` (0) s'empaquette — `packZoneKind(element,
  // 0) === element` pour tout element sur 3 bits, donc le comportement d'avant
  // la tache 5 est preserve a l'identique pour ces paires-la.
  const reactionId = reactionForPair(trigger.pair)?.id ?? REACTION.AUCUNE;
  const avant = zones.count;
  const creneau = zones.spawn(
    packZoneKind(trigger.element, reactionId),
    Math.round(trigger.x),
    Math.round(trigger.y),
    trigger.by,
    tick,
  );
  // ⚠️ **Pas de `creneau >= 0` en plus : la comparaison des comptes le couvre
  // deja** (mutation appliquee, elle survivait). `spawn` ne rend `-1` que
  // reserve pleine, et alors elle n'a rien cree non plus — les deux gardes
  // repondraient toujours ensemble, et la seconde ne pourrait jamais rougir.
  //
  // ⚠️ **Les declencheurs nes ici tombent dans le lot du tick SUIVANT**, et
  // c'est voulu : `Room.step` a deja draine celui-ci. Un champ qui reagirait
  // avec son voisin dans le meme tick le ferait pendant que `applyReactions`
  // balaie encore la horde par creneau — exactement ce que la collecte differee
  // de `Reactions` existe pour eviter.
  if (zones.count > avant) {
    reactions.onZoneCreated(zones, creneau, tick);
  }
}

/**
 * Marque tout ennemi qui se trouve DANS une zone, et rafraichit la marque
 * tant qu'il y reste (§5.2 de la spec).
 *
 * O(zones x entites) — le cout que le §5.2 annonce et que la tache 10 doit
 * mesurer. Meme balayage que `Horde#computeSlow`, mais **serveur seul** : la
 * marque ne voyage pas (§2), et c'est elle qui arbitre, donc le client n'a
 * rien a en deriver.
 *
 * ⚠️ **`aliveAt`, pas `slowsAt`, et le predicat reste le bon meme si l'ordre
 * du tick a change a la tache 21.** Les zones naissaient AVANT ce balayage
 * (une par fin de course de projectile), donc une zone posee au tick `T`
 * marquait des `T` ; elles naissent maintenant de `applyReactions`, donc
 * APRES, et une zone posee au tick `T` ne marque qu'a `T + 1` — comme elle ne
 * ralentit qu'a `T + 1`. Les deux effets partent desormais ensemble.
 *
 * `aliveAt` reste malgre tout le predicat juste : c'est celui qui dit si la
 * zone EXISTE, et il n'appartient pas a ce balayage de rattraper l'ordre du
 * tick. `slowsAt` porte, lui, une regle differente — un deplacement deja joue
 * — qui vaut quel que soit l'ordre. Voir la table de `ZoneField.slowsAt`.
 *
 * ⚠️ **Un ennemi couvert par une zone d'un AUTRE element que sa marque REAGIT**
 * (§6.2, seconde ligne), et c'est `applyElement` qui en decide — la marque
 * n'est plus jamais ecrasee en silence. La borne « une reaction par ennemi et
 * par tick » vit dans `Reactions` : ce balayage la traverse plusieurs fois par
 * tick des que deux zones se chevauchent, et sans elle chaque paire de zones
 * multiplierait les reactions par le nombre d'ennemis dans leur intersection.
 *
 * ⚠️ **`reactions` n'est PAS optionnel ici, contrairement a
 * `resolveProjectileDamage`.** Il n'existe aucun appelant legitime qui
 * marquerait par zone sans arbitrer les reactions : ce serait le §6.2 desactive
 * en silence.
 */
export function markInZones(
  horde: Horde,
  zones: ZoneField,
  tick: number,
  reactions: Reactions,
): void {
  const r2 = ZONE_RADIUS * ZONE_RADIUS;
  for (let z = 0; z < zones.count; z++) {
    if (!zones.aliveAt(z, tick)) {
      continue;
    }
    const element = zoneElement(zones.kind[z] ?? 0);
    const by = zones.by[z] ?? 0;
    const zx = zones.x[z] ?? 0;
    const zy = zones.y[z] ?? 0;
    for (let i = 0; i < horde.count; i++) {
      const dx = (horde.x[i] ?? 0) - zx;
      const dy = (horde.y[i] ?? 0) - zy;
      if (dx * dx + dy * dy < r2) {
        applyElement(horde, reactions, i, element, by, tick);
      }
    }
  }
}

/**
 * La Braise brule : applique `Element.burnPerTick` a chaque ennemi dont la
 * marque tient encore, PUIS les zones de Surchauffe brulent d'elles-memes
 * (tache 6 de l'etape 5b) — et rend les identites de ceux qui en meurent.
 *
 * ⚠️ **Les morts par brulure passent par le `DEATHS` EXISTANT, jamais par un
 * chemin parallele.** Le rejeu de l'etape 3 en depend : un client apprend qui
 * meurt par ce seul message, revient au tick de la mort et rejoue. Un second
 * canal — ou un second lot au meme tick — casserait l'hypothese que
 * `GameClient#drainPendingDeaths` documente noir sur blanc (« `Room.step`
 * n'empile jamais qu'UN SEUL `DEATHS` par tick »), et un lot rejoue apres un
 * autre du meme tick effacerait la correction du premier. C'est donc `Room`
 * qui FUSIONNE ces identites avec celles des projectiles avant de mettre en
 * file — voir `Room.step`.
 *
 * Les orbes sont derives ici comme dans `resolveProjectileDamage`, a la
 * position lue AVANT la compaction : le §6.1 de la spec de l'etape 3 fait de
 * chaque mort un orbe, et le §12 de celle-ci confirme qu'une mort elementaire
 * n'y fait pas exception — « sinon le systeme elementaire punirait
 * l'experience de l'equipe ».
 *
 * ⚠️ **La brulure de zone (Surchauffe) est un SECOND balayage dans la MEME
 * fonction, pas une fonction a part.** Elle ne peut pas se lire generiquement
 * au site de la marque : une zone de Surchauffe porte l'element du
 * DECLENCHEUR (Braise ou Foudre selon l'ordre d'arrivee, voir
 * `ReactionTrigger.element`), et si c'est Foudre, marquer les ennemis dessous
 * les marquerait de Foudre — dont `Element.burnPerTick` est nul. Le taux vient
 * donc de `ZoneField.burnAt` (`shared/zones.ts`), qui lit le nibble de
 * reaction du `kind` empaquete via `zoneBurnPerTick`, jamais l'element — et
 * qui prend deja le MAXIMUM entre zones qui se recouvrent (voir son docbloc
 * et B2 du rapport de la revue finale de l'etape 5b). Rester dans CETTE
 * fonction plutot que d'en ecrire une seconde suffit a tenir la contrainte du
 * `DEATHS` unique : un seul `dead`, une seule compaction, un seul appelant
 * cote `Room.step`.
 */
export function resolveBurn(
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
): number[] {
  const dead: number[] = [];
  for (let i = 0; i < horde.count; i++) {
    const burn = elementOf(horde.markAt(i, tick)).burnPerTick;
    if (burn <= 0) {
      continue;
    }
    // ⚠️ **La borne de mort est `<= 0`, et elle vit maintenant dans
    // `appliquerDegats` — mais AUCUN TEST NE PEUT la separer de `< 0` DEPUIS
    // ICI, et c'est arithmetique.** `Horde.hp` est un `Float32Array` et
    // `burnPerTick` vaut 0,1, qui n'y est pas representable : soustraire le
    // double 0,1 d'une reserve arrondie en simple precision ne peut jamais
    // tomber sur exactement zero. Ce sont les degats ENTIERS des projectiles
    // et des reactions qui tiennent cette borne. Dit tel quel plutot que de
    // laisser croire a une borne testee de partout ; la garder alignee vaut
    // mieux que de la relacher pour une raison qui tient au format de
    // stockage, pas a la regle.
    appliquerDegats(horde, i, burn, zones, tick, dead);
  }
  // ⚠️ **Meme predicat que `markInZones` : `aliveAt`, pas `slowsAt`.** Ce
  // balayage inflige un degat, pas un deplacement — la borne stricte de
  // `slowsAt` (la horde a deja avance ce tick-la) ne concerne que le
  // ralentissement, voir `ZoneField.slowsAt`.
  //
  // ⚠️ **UNE SEULE liste pour toutes les zones qui se recouvrent, jamais une
  // passe par zone — corrige a la revue finale de l'etape 5b (B2).** Le
  // premier jet bouclait ZONE puis entite et appelait `appliquerDegats` une
  // fois PAR ZONE couvrant l'ennemi : deux zones de Surchauffe superposees a
  // declencheurs opposes (Braise et Foudre) doublaient la perte par tick,
  // quatre la quadruplaient — mesure : 0,300 / 0,600 / 1,200 PV/tick, soit
  // 72 PV/s au pire cas, `HEAVY_HP` (20) en 0,28 s. C'est exactement le
  // « deux sources de verite » que le docbloc de `damageInRadius` denonce
  // pour un AUTRE balayage, et que celui-ci commettait en silence.
  // `ZoneField.burnAt` prend deja le MAXIMUM entre zones qui se recouvrent
  // (meme regle que `ampAt`/`armorReductionAt`/`collisionDamageAt` — voir
  // son docbloc) : boucler par ENTITE et lui appliquer ce maximum UNE SEULE
  // fois suffit.
  for (let i = 0; i < horde.count; i++) {
    // ⚠️ **Un ennemi DEJA note dans `dead` ne reprend pas de degats.** Le
    // balayage de marque ci-dessus peut avoir amene sa reserve a `<= 0` sans
    // compacter (`horde.kill` n'arrive qu'a la toute fin de cette fonction).
    if ((horde.hp[i] ?? 0) <= 0) {
      continue;
    }
    const burn = zones.burnAt(horde.x[i] ?? 0, horde.y[i] ?? 0, tick);
    if (burn <= 0) {
      continue;
    }
    appliquerDegats(horde, i, burn, zones, tick, dead);
  }
  if (dead.length === 0) {
    return dead;
  }
  for (const id of dead) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(dead);
  return dead;
}

/**
 * Verglas (Givre + Poix, tache 8 de l'etape 5b) : la seconde moitie de la
 * reaction — *« les ennemis derapent ET se percutent »*. Le derapage
 * (le premier mot) VOYAGE et vit dans `Horde#recomputeSteering`
 * (`shared/horde.ts`) ; la collision (le second) est un DEGAT, donc arbitree
 * ici, cote serveur seul.
 *
 * ⚠️ **Aucune contrainte de replication, contrairement au derapage.** Le
 * client ne prononce jamais de degat (§2) ; seules les morts qui en
 * resultent voyagent, par `DEATHS` comme toujours — exactement le meme
 * partage que `armureA`/`ampAt` (qui ne voyagent pas) face a
 * `Horde#computeSlow` (qui voyage).
 *
 * ⚠️ **Aucun etat nouveau sur `Horde`.** La liste des ennemis « glissants »
 * de ce tick est un tableau LOCAL a cette fonction, jamais un quinzieme
 * tableau type sur `Horde` — voir la contrainte dure de la tache 8. Elle se
 * REDERIVE chaque tick, exactement comme `#slow` dans `Horde`.
 *
 * ⚠️ **Une SEULE liste pour toutes les zones qui se recouvrent, jamais une
 * passe par zone.** Un ennemi couvert par deux zones de Verglas qui se
 * chevauchent ne doit pas se percuter deux fois avec le meme voisin —
 * `ZoneField.collisionDamageAt` a deja pris le MAXIMUM entre zones (comme
 * `ampAt`/`armorReductionAt`) avant que cette fonction n'apparie qui que ce
 * soit.
 *
 * ⚠️ **La distance de collision est `SEPARATION_RADIUS` (28 px) — la meme
 * distance de confort que `Horde#recomputeSteering` maintient normalement
 * entre voisins.** Deux ennemis qui se retrouvent plus proches que ca
 * n'ont, par construction, pas pu se repousser correctement : c'est le
 * derapage qui les y a laisses.
 *
 * Cout : O(zones x entites) pour reperer les glissants (meme ordre que
 * `Horde#computeSlow`/`markInZones`), puis O(k²) sur les k glissants trouves.
 *
 * ⚠️ **k n'est PAS borne par « la geometrie » seule — c'est incomplet dans
 * les DEUX sens, mesure a la tache 10 de l'etape 5b (`back/bench/elements.bench.ts`,
 * scenario Verglas).** Deux mecanismes DISTINCTS le retiennent, et ils
 * mordent dans cet ORDRE :
 *
 * 1. **La mort par collision, au reglage actuel.** `VERGLAS_COLLISION_DAMAGE_PER_TICK`
 *    (0,2) tue les glissants entasses en quelques dizaines de ticks, ce qui
 *    vide la zone avant qu'elle ne deborde — k plafonne a **33** (vague
 *    ENCIRCLE de 200 a 3500 LOURDS convergeant sur une zone entretenue en
 *    continu, le pire cas mesure).
 * 2. **Le tassement a `SEPARATION_RADIUS`, GEOMETRIQUE celui-la.** En
 *    reduisant le degat de collision (un dixieme, 0,02 : k monte a 54, quasi
 *    aucune mort ; un vingtieme, 0,01 : k monte a **58** et n'y depasse plus,
 *    avec ZERO mort observee) — c'est SEULEMENT a ce second palier que la
 *    geometrie devient la borne active. Au reglage de jeu actuel, c'est le
 *    premier mecanisme qui joue, pas le second.
 *
 * Aucun des deux ne menace le budget : k devrait approcher 380 pour que
 * l'O(k²) rivalise avec le budget de tick mesure au banc — un facteur x6,5
 * au-dela du pire k observe meme au reglage degrade. Documente ici pour que
 * la prochaine lecture de ce docbloc n'affirme plus a moitie une verite.
 */
export function resolveVerglasCollisions(
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
): number[] {
  const dead: number[] = [];
  const sliding: number[] = [];
  const slidingDamage: number[] = [];
  for (let i = 0; i < horde.count; i++) {
    if ((horde.hp[i] ?? 0) <= 0) {
      continue;
    }
    const damage = zones.collisionDamageAt(horde.x[i] ?? 0, horde.y[i] ?? 0, tick);
    if (damage <= 0) {
      continue;
    }
    sliding.push(i);
    slidingDamage.push(damage);
  }

  const r2 = SEPARATION_RADIUS * SEPARATION_RADIUS;
  for (let a = 0; a < sliding.length; a++) {
    const i = sliding[a] ?? 0;
    for (let b = a + 1; b < sliding.length; b++) {
      const j = sliding[b] ?? 0;
      // ⚠️ **Verifie a CHAQUE paire, pas une fois a l'entree de la boucle
      // externe.** `i` peut mourir d'une paire precedente dans cette meme
      // boucle interne (deux voisins glissants simultanement) ; sans cette
      // garde fraiche, `appliquerDegats` reprendrait une reserve deja a
      // `<= 0` et listerait `i` deux fois dans `dead` — meme raisonnement
      // que `resolveBurn`.
      if ((horde.hp[i] ?? 0) <= 0 || (horde.hp[j] ?? 0) <= 0) {
        continue;
      }
      const dx = (horde.x[i] ?? 0) - (horde.x[j] ?? 0);
      const dy = (horde.y[i] ?? 0) - (horde.y[j] ?? 0);
      if (dx * dx + dy * dy >= r2) {
        continue;
      }
      appliquerDegats(horde, i, slidingDamage[a] ?? 0, zones, tick, dead);
      appliquerDegats(horde, j, slidingDamage[b] ?? 0, zones, tick, dead);
    }
  }

  if (dead.length === 0) {
    return dead;
  }
  for (const id of dead) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0);
    }
  }
  horde.kill(dead);
  return dead;
}
