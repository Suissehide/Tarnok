import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  ORB_LIFETIME_TICKS,
  ORB_PICKUP_RADIUS,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { dropsOrb, type Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';
import { packElementPair } from '@shared/protocol';
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
 * directement, sans adaptateur — `resolveContact` et `resolvePickups`
 * modifient les objets qu'on leur passe EN PLACE, comme `Horde.step`
 * modifie une `Horde` en place.
 */
export interface ContactPlayer {
  readonly x: number;
  readonly y: number;
  hp: number;
  /** Ticks restants avant qu'un nouveau contact puisse a nouveau faire mal. */
  contactInvulnTicks: number;
}

/** Un point que `resolvePickups` compare aux orbes vivants. Sous-ensemble structurel de `ContactPlayer`. */
export interface PickupPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Orbes vivants, derives des morts (§6.1 de la spec) : chaque mort de
 * monstre laisse un orbe a sa position, portant l'identite du monstre —
 * « rien a allouer, rien a synchroniser ». Tableaux types, jamais un objet
 * par orbe, meme raisonnement que `Horde` et `Projectiles`.
 *
 * Capacite bornee a `MAX_ENTITIES` (passee par l'appelant) : au plus un orbe
 * vit par mort, et une mort ne peut jamais depasser le nombre d'entites que
 * la horde a pu contenir. Tres large en pratique — `WaveDirector` apporte
 * 120 a 320 entites toutes les 6 s, loin sous ce plafond meme cumule sur
 * `ORB_LIFETIME_TICKS` (20 s).
 */
export class OrbField {
  /** Identite du monstre qui a laisse l'orbe. Public en lecture, comme `Horde.entityIdAt`. */
  readonly id: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Tick de la mort qui a fait apparaitre l'orbe. Public : la tache 11 en aura besoin pour un fondu. */
  readonly bornTick: Uint32Array;
  #count = 0;

  constructor(readonly capacity: number) {
    this.id = new Uint32Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.bornTick = new Uint32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Une mort DEMANDE un orbe ; toutes ne l'obtiennent pas (tache 17, etape 5a).
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
   * Ignore silencieusement si la capacite (tres large) est atteinte.
   */
  spawn(entityId: number, x: number, y: number, tick: number): void {
    if (!dropsOrb(entityId)) {
      return;
    }
    if (this.#count >= this.capacity) {
      return;
    }
    const slot = this.#count++;
    this.id[slot] = entityId;
    this.x[slot] = x;
    this.y[slot] = y;
    this.bornTick[slot] = tick;
  }

  /**
   * Etape 10 de la sequence serveur : expire d'abord les orbes perimes —
   * expiration DERIVEE (§6.1), aucun message : les deux cotes calculent la
   * meme date de peremption a partir du meme `bornTick`, connu depuis le
   * message DEATHS — puis resout les ramassages. Rend les identites
   * ramassees (= celles des monstres qui les ont laissees), pour le message
   * PICKUPS et le calcul de l'experience gagnee, cote `Room`.
   *
   * Retrait par indice decroissant, meme raisonnement que `Horde.kill` et
   * `Projectiles.#removeAt` : un orbe deplace dans un trou par une
   * compaction ne doit jamais etre lui-meme saute par erreur ensuite.
   */
  resolvePickups(players: readonly PickupPoint[], tick: number): number[] {
    this.expire(tick);

    const r2 = ORB_PICKUP_RADIUS * ORB_PICKUP_RADIUS;
    const picked: number[] = [];
    for (let i = this.#count - 1; i >= 0; i--) {
      const ox = this.x[i] ?? 0;
      const oy = this.y[i] ?? 0;
      let caught = false;
      for (const p of players) {
        const dx = ox - p.x;
        const dy = oy - p.y;
        if (dx * dx + dy * dy <= r2) {
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

  /** Retire les orbes dont la duree de vie a expire. Voir `resolvePickups`. */
  expire(tick: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (tick - (this.bornTick[i] ?? 0) >= ORB_LIFETIME_TICKS) {
        this.#removeAt(i);
      }
    }
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.id[slot] = this.id[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
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
    const element = zones.element[created] ?? 0;
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
      const other = zones.element[i] ?? 0;
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
 * Resout les reactions collectees pendant le tick : `REACTION_DAMAGE` a tout
 * ennemi dans `REACTION_RADIUS` de chaque point, et rend les identites de ceux
 * qui en meurent.
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

  const r2 = REACTION_RADIUS * REACTION_RADIUS;
  const dead = new Set<number>();
  for (const t of triggers) {
    for (let i = 0; i < horde.count; i++) {
      const dx = (horde.x[i] ?? 0) - t.x;
      const dy = (horde.y[i] ?? 0) - t.y;
      if (dx * dx + dy * dy >= r2) {
        continue;
      }
      const reste = (horde.hp[i] ?? 0) - REACTION_DAMAGE;
      horde.hp[i] = reste;
      if (reste <= 0) {
        dead.add(horde.entityIdAt(i));
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
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0, tick);
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
 */
export function resolveProjectileDamage(
  projectiles: Projectiles,
  dt: number,
  horde: Horde,
  orbs: OrbField,
  tick: number,
  reactions?: Reactions,
): number[] {
  // ⚠️ **Un projectile ne laisse plus RIEN au sol** (tache 21). Il posait une
  // zone a ses DEUX fins de course — la vieillesse dans `step`, l'impact dans
  // `collide` — et les deux sont parties ensemble, avec le parametre `zones`
  // et le rappel `onExpire` de `Projectiles.step` qui n'existait que pour la
  // premiere. Ce qui reste au projectile, c'est de MARQUER ce qu'il touche :
  // le seul chemin qui mene a la premiere reaction, donc au premier champ.
  projectiles.step(dt);

  const dead = new Set<number>();
  projectiles.collide(horde, (entityId, damage, projectileSlot) => {
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
    const reste = (horde.hp[slot] ?? 0) - damage;
    horde.hp[slot] = reste;
    if (reste <= 0) {
      // ⚠️ **UN ENNEMI QUI MEURT DU MEME IMPACT N'EST PAS MARQUE.** Un mort ne
      // porte pas d'element : c'est la reaction qui consomme une marque, et il
      // n'y a plus rien a consommer.
      //
      // ⚠️ **Et AUCUN TEST NE GARDE ce `return` — verifie par application, pas
      // raisonne.** Le plan de l'etape 5a annonce ici la classe de defaut la
      // plus couteuse du depot (« la marque serait posee sur un creneau que
      // `kill` va compacter, donc sur une AUTRE entite »). **C'est faux avec le
      // `Horde` d'aujourd'hui, et la mutation le prouve** : `#removeAt` copie
      // la DERNIERE entite DANS le creneau libere, donc la marque posee sur le
      // mourant est ECRASEE par les donnees propres du survivant, jamais
      // heritee. Et quand le mourant occupe deja le dernier creneau, la marque
      // survit au-dela du compte — ou `Horde.spawn` la remet a `NEUTRE`
      // (correctif R16 de l'etape 4). Les deux chemins sont couverts.
      //
      // Garde quand meme, et dit tel quel plutot que de laisser croire a une
      // garde testee (meme choix que le `slot < 0` ci-dessus) : il encode
      // l'intention, et il redevient porteur le jour ou `#removeAt` cesserait
      // d'ecraser — un `kill` qui se contenterait de decrementer le compte,
      // par exemple.
      dead.add(entityId);
      return;
    }
    if (element !== ELEMENT.NEUTRE) {
      // Le §6.2, premiere ligne : un ennemi deja marque d'un AUTRE element
      // reagit ; marque du MEME, il ne fait que rafraichir. `applyElement`
      // porte les deux cas, exactement comme pour les zones.
      applyElement(horde, reactions, slot, element, by, tick);
    }
  });
  if (dead.size === 0) {
    return [];
  }

  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0, tick);
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
      player.hp = Math.max(0, player.hp - CONTACT_DAMAGE);
      player.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
    }
  }
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
  const avant = zones.count;
  const creneau = zones.spawn(
    trigger.element,
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
    const element = zones.element[z] ?? 0;
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
 * marque tient encore, et rend les identites de ceux qui en meurent.
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
 */
export function resolveBurn(horde: Horde, orbs: OrbField, tick: number): number[] {
  const dead: number[] = [];
  for (let i = 0; i < horde.count; i++) {
    const burn = elementOf(horde.markAt(i, tick)).burnPerTick;
    if (burn <= 0) {
      continue;
    }
    const reste = (horde.hp[i] ?? 0) - burn;
    horde.hp[i] = reste;
    // ⚠️ **`<= 0`, comme `resolveProjectileDamage` — mais AUCUN TEST NE PEUT
    // separer cette borne de `< 0` ici, et c'est arithmetique.** `Horde.hp`
    // est un `Float32Array` et `burnPerTick` vaut 0,1, qui n'y est pas
    // representable : soustraire le double 0,1 d'une reserve arrondie en
    // simple precision ne peut jamais tomber sur exactement zero. La mutation
    // `reste < 0` survit donc a toute la suite — verifie par application. Dit
    // tel quel plutot que de laisser croire a une borne testee ; la garder
    // alignee sur celle des projectiles vaut mieux que de la relacher pour une
    // raison qui tient au format de stockage, pas a la regle.
    if (reste <= 0) {
      dead.push(horde.entityIdAt(i));
    }
  }
  if (dead.length === 0) {
    return dead;
  }
  for (const id of dead) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(id, horde.x[slot] ?? 0, horde.y[slot] ?? 0, tick);
    }
  }
  horde.kill(dead);
  return dead;
}
