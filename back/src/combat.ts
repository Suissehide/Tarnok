import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  ORB_LIFETIME_TICKS,
  ORB_PICKUP_RADIUS,
} from '@shared/constants';
import type { Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';

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
 * ⚠️ **Decision de conception, absente du plan.** Les monstres de pietaille
 * (`shared/archetypes.ts`) n'ont aucune reserve de points de vie : le tableau
 * « Coherence des constantes » du plan d'etape 3 ne definit ni `MONSTER_HP`
 * ni aucun equivalent, alors qu'il est exhaustif sur tout le reste. Le §4.1
 * de la spec d'orientation les decrit comme de la « chair a canon ». Un
 * projectile qui touche est donc TOUJOURS letal pour cette etape :
 * `Weapon.damage` reste transporte (affichage, futures elites du §3.3 —
 * hors perimetre) mais ne module aucune reserve de PV ici. Voir le rapport
 * de la tache 9 pour la justification complete.
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
 * ⚠️ **Deduplique avant `horde.kill`.** Deux projectiles peuvent toucher la
 * MEME entite au meme tick (deux tireurs convergents) : `Projectiles.collide`
 * consomme chaque projectile independamment et ne sait pas qu'une autre
 * touche a deja ete enregistree ce tick. Sans deduplication, la meme identite
 * serait listee deux fois dans le lot diffuse — ce que le §3.1 de la spec
 * interdit (« triees en ordre croissant » suppose des identites uniques) et
 * que `Horde.kill` ne fait que tolerer defensivement (voir sa doc). Le `Set`
 * ci-dessous rend cette garantie structurelle plutot que defensive.
 */
export function resolveProjectileDamage(
  projectiles: Projectiles,
  dt: number,
  horde: Horde,
  orbs: OrbField,
  tick: number,
): number[] {
  projectiles.step(dt);

  const dead = new Set<number>();
  projectiles.collide(horde, (entityId) => {
    dead.add(entityId);
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
