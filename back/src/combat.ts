import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  ORB_LIFETIME_TICKS,
  ORB_PICKUP_RADIUS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import type { Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';
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

  /** Fait apparaitre un orbe. Ignore silencieusement si la capacite (tres large) est atteinte. */
  spawn(entityId: number, x: number, y: number, tick: number): void {
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
  zones?: ZoneField,
): number[] {
  // ⚠️ **Une zone se pose la ou le projectile FINIT SA COURSE, qu'il ait
  // touche ou non** (§5.1 de la spec). Les deux fins de course sont a deux
  // endroits differents de cette classe : la vieillesse, ici dans `step`, et
  // l'impact, plus bas dans `collide`. N'en cabler qu'une laisserait la moitie
  // des tirs elementaires sans trace au sol — invisible au type, invisible au
  // lint.
  projectiles.step(dt, zones ? (slot) => postZone(zones, projectiles, slot, tick) : undefined);

  const dead = new Set<number>();
  projectiles.collide(horde, (entityId, damage, projectileSlot) => {
    if (zones) {
      postZone(zones, projectiles, projectileSlot, tick);
    }
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
      horde.applyMark(slot, element, by, tick);
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
 * Pose la zone d'un projectile qui vient de finir sa course — creation, ou
 * rafraichissement de celle qui couvre deja le point (§5.1 bis, la regle qui
 * BORNE le nombre de zones).
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
 * Un projectile neutre ne pose rien : c'est le SEUL garde, et il est ici
 * plutot que dans `ZoneField` — une zone neutre n'aurait ni teinte, ni
 * brulure, ni ralentissement, mais elle consommerait un creneau de la reserve
 * et compterait dans le O(zones x entites).
 */
function postZone(zones: ZoneField, projectiles: Projectiles, slot: number, tick: number): void {
  const element = projectiles.elementAt(slot);
  if (element === ELEMENT.NEUTRE) {
    return;
  }
  zones.spawn(
    element,
    Math.round(projectiles.x[slot] ?? 0),
    Math.round(projectiles.y[slot] ?? 0),
    projectiles.ownerAt(slot),
    tick,
  );
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
 * ⚠️ **`aliveAt`, pas `slowsAt`.** Ce balayage tourne APRES la pose des zones
 * du meme tick : une zone posee a ce tick doit marquer immediatement ce
 * qu'elle couvre. Le ralentissement, lui, ne prend qu'au tick suivant, parce
 * qu'il porte sur un deplacement DEJA joue quand la zone est posee. Voir la
 * table de `ZoneField.slowsAt`.
 *
 * ⚠️ **La derniere zone visitee gagne, et rien n'arbitre encore.** Un ennemi
 * couvert par deux zones d'elements differents devrait REAGIR (§6.2) : c'est
 * la tache 7. Ici, un element SEUL, et la marque est simplement ecrasee.
 */
export function markInZones(horde: Horde, zones: ZoneField, tick: number): void {
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
        horde.applyMark(i, element, by, tick);
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
