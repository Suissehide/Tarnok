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
  CONTAGION_RADIUS,
  COURT_CIRCUIT_MAX_JUMPS,
  REACTION_DAMAGE,
  REACTION_RADIUS,
  SEPARATION_RADIUS,
  ZONE_RADIUS,
} from '@shared/constants';
import { ELEMENT, elementOf } from '@shared/elements';
import { type Horde, leavesDrop } from '@shared/horde';
import { linkedNeighbours } from '@shared/links';
import { type Onde, ondeBand } from '@shared/onde-frappe';
import { type Anchor, distanceToSegmentSquared, type Projectiles } from '@shared/projectiles';
import { packElementPair, packZoneKind, zoneElement } from '@shared/protocol';
import { REACTION, reactionForPair } from '@shared/reactions';
import { NEUTRE_MARQUE_AMP } from '@shared/weapons';
import type { ZoneField } from '@shared/zones';

/**
 * L'arbitrage de combat, cote serveur : degats de projectiles, morts, contact
 * avec les joueurs, ramassage d'orbes (etapes 8 a 10 de `Room.step`, voir
 * l'en-tete de `room.ts`).
 *
 * Comme `room.ts`, ce fichier ne connait ni `ws` ni `fastify` (regle Biome) :
 * c'est ce qui rend le passage a `worker_threads` mecanique et l'arbitrage
 * testable sans serveur.
 *
 * ⚠️ Les PV des ennemis (`Archetype.hp`, poses par `Horde.spawn`) sont
 * soustraits ICI et nulle part ailleurs. Ils ne quittent jamais le serveur : le
 * client apprend qui meurt par `DEATHS`.
 */

/** Ce qu'il faut d'un joueur pour lui faire mal. `PlayerState` le satisfait. */
export interface HurtablePlayer {
  hp: number;
  /** Reserve de bouclier restante. `0` chez qui ne porte pas Transcendance. */
  shield: number;
  /** Ticks ecoules sans degat — remis a zero par tout coup recu. */
  shieldCalmTicks: number;
  /** Fraction des degats absorbee. Absente : 0. Negative (malus) : il encaisse plus. */
  readonly armor?: number;
}

/**
 * Inflige `degats` a un joueur — **le SEUL endroit du depot ou les PV d'un
 * joueur baissent**. Tir d'ennemi, kamikaze, contact et charge du boss passent
 * tous ici : sinon le bouclier serait traversable par les sources oubliees.
 *
 * ⚠️ **Le facteur est borne a zero.** `armor` depasse 1 chez un compte tres
 * ameliore ; sans cette borne, un coup SOIGNERAIT.
 *
 * ⚠️ **Ordre : armure, PUIS bouclier, PUIS PV.** Le bouclier mord sur ce qui
 * RESTE apres l'armure, jamais sur le brut.
 */
export function hurtPlayer(p: HurtablePlayer, degats: number): void {
  const recu = degats * Math.max(0, 1 - (p.armor ?? 0));
  if (recu <= 0) {
    return;
  }
  // ⚠️ **Tout degat RECU remet le calme a zero**, meme entierement absorbe :
  // sinon un joueur grignote sa reserve indefiniment sans jamais retarder sa
  // recharge, et le bouclier devient une reduction de degats permanente.
  p.shieldCalmTicks = 0;
  const absorbe = Math.min(p.shield, recu);
  p.shield -= absorbe;
  p.hp = Math.max(0, p.hp - (recu - absorbe));
}

/**
 * Un joueur tel que l'arbitrage de contact le voit : position en lecture,
 * points de vie et compte a rebours d'invulnerabilite mutables.
 * `Room.PlayerState` la satisfait directement ; `resolveContact` modifie les
 * objets EN PLACE.
 */
export interface ContactPlayer {
  readonly x: number;
  readonly y: number;
  hp: number;
  /** Reserve de bouclier restante. `0` chez qui ne porte pas Transcendance. */
  shield: number;
  /** Ticks ecoules sans degat — remis a zero par tout coup recu. */
  shieldCalmTicks: number;
  /** Ticks restants avant qu'un nouveau contact puisse a nouveau faire mal. */
  contactInvulnTicks: number;
  /**
   * Fraction des degats recus absorbee (amelioration « Armure » du compte).
   * Optionnelle : absente, elle vaut 0 — les tests de contact n'ont rien a poser.
   */
  readonly armor?: number;
}

/**
 * Un point que `resolvePickups` compare aux orbes vivants. `pickupRadius` est
 * personnel (base plus achats d'aimant) et `ContactPlayer` ne le porte pas :
 * `room.ts` construit l'adaptateur avant d'appeler `resolvePickups`.
 */
export interface PickupPoint {
  readonly x: number;
  readonly y: number;
  /** Rayon de ramassage de CE joueur : `ORB_PICKUP_RADIUS` plus ses achats. */
  readonly pickupRadius: number;
}

/**
 * Orbes vivants : chaque mort de monstre qui laisse un butin pose un orbe a sa
 * position, portant l'identite du monstre. Tableaux types, jamais un objet par
 * orbe, comme `Horde` et `Projectiles`.
 *
 * ⚠️ **Un orbe n'expire jamais**, des deux cotes du fil : une peremption
 * retiree d'un seul cote ferait disparaitre chez l'un un orbe que l'autre
 * ramasse encore.
 *
 * ⚠️ **La capacite est donc la seule borne, et elle est SILENCIEUSE** : `spawn`
 * ne fait rien quand la reserve est pleine, d'ou `truncatedOrbs`, comme
 * `Projectiles.truncatedProjectiles` et `ZoneField.truncatedZones`.
 *
 * Capacite `MAX_ENTITIES` (passee par l'appelant). `kills.bench.ts` montre
 * qu'au pire (dix minutes, personne ne ramasse rien) la reserve reste tres
 * loin de la saturation, et que la horde sature bien avant elle.
 */
export class OrbField {
  /** Identite du monstre qui a laisse l'orbe. Public en lecture, comme `Horde.entityIdAt`. */
  readonly id: Uint32Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /*
   * Pas de `bornTick` ici : sans expiration, rien ne le relirait.
   * `DerivedOrbs` garde le sien, car `OrbRenderer` en tire la phase du
   * scintillement.
   */
  /**
   * Orbes qu'une mort a demandes et que la reserve pleine n'a pas poses,
   * depuis le debut de la run (cumulatif).
   *
   * ⚠️ **Compte les orbes REFUSES PAR LA CAPACITE, pas les morts sans orbe**
   * (`leavesDrop`) : sinon il monterait tout le temps et ne dirait plus rien
   * du plafond qu'il surveille.
   */
  truncatedOrbs = 0;
  #count = 0;

  /**
   * `(x, y, mark, markBy)` a plat de CHAQUE mort depuis le dernier
   * `drainFallen`, qu'elle laisse un orbe ou non. `Room.step` vide la file a
   * chaque tick (Contagion).
   *
   * ⚠️ **Ici parce que c'est le seul goulot qui voit chaque mort AVEC sa
   * position ET sa marque encore valides** : tous les chemins de mort de ce
   * fichier appellent `spawn` juste avant `horde.kill`, qui compacte la horde.
   * Apres, un creneau ne porte plus la marque du mort.
   *
   * ⚠️ **`markBy` voyage AVEC `mark`.** `0` n'est pas une marque neutre, c'est
   * la sentinelle « aucun joueur » (identites a partir de 1) ; la Synergie
   * compare `markBy !== by` (`room.ts`), donc une marque propagee sans son
   * auteur chargerait la barre a chaque reaction, y compris en solo.
   */
  #fallen: number[] = [];

  drainFallen(): number[] {
    const out = this.#fallen;
    this.#fallen = [];
    return out;
  }

  constructor(readonly capacity: number) {
    this.id = new Uint32Array(capacity);
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Une mort DEMANDE un orbe ; toutes ne l'obtiennent pas (`leavesDrop`).
   *
   * La reserve tient deux natures, orbes d'experience et pieces, sans le
   * savoir : la nature se relit de l'identite (`dropsOrb` / `dropsCoin`,
   * disjoints) au dessin et au ramassage. Une seconde reserve doublerait
   * capacite, compteur et calque de rendu pour un objet qui tombe et se
   * ramasse pareil.
   *
   * ⚠️ **La garde est ICI, au goulot, et pas dans les chemins de mort** : une
   * regle recopiee a chaque appel serait fausse au prochain chemin ajoute.
   *
   * ⚠️ **`DerivedOrbs.spawn` porte la MEME garde, cote client** (predicat
   * partage dans `shared/`). La retirer d'un seul cote ferait apparaitre chez
   * l'un des orbes que l'autre ignore.
   *
   * ⚠️ **Refus silencieux a capacite pleine, mais COMPTE** (`truncatedOrbs`).
   */
  // `mark`/`markBy` par defaut a `NEUTRE`/`0` : `spreadMarkOnDeath` ignore
  // toute marque `NEUTRE`, donc cet auteur par defaut ne voyage jamais.
  spawn(entityId: number, x: number, y: number, mark: number = ELEMENT.NEUTRE, markBy = 0): void {
    // AVANT la garde du butin : Contagion compte les morts, pas les orbes.
    this.#fallen.push(x, y, mark, markBy);
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
   * Etape 10 de la sequence serveur : resout les ramassages, seule sortie d'un
   * orbe. Rend les identites ramassees (= celles des monstres qui les ont
   * laissees), pour PICKUPS et l'experience gagnee cote `Room`.
   *
   * Retrait par indice decroissant, comme `Horde.kill` : un orbe deplace dans
   * un trou par une compaction ne doit jamais etre saute ensuite.
   */
  resolvePickups(players: readonly PickupPoint[]): number[] {
    // Un `r2` par joueur, precalcule hors des deux boucles.
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
 * Une reaction qui vient d'etre declenchee, avant d'etre resolue et annoncee.
 *
 * ⚠️ **Porte les DEUX joueurs, alors que le message `REACTION` n'en porte
 * aucun** : le serveur COMPARE deux identites (charge de Synergie, faite par
 * `Room.step`), le fil ne transporte que le booleen qui en sort.
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
   * laisse au sol**. `pair` ne suffit pas : canonicalise, il a perdu l'ordre.
   *
   * ⚠️ **Le second, pas celui de la marque.** Avec celui de la marque, le champ
   * remarque l'ennemi de l'element que la reaction vient de consommer, et le
   * meme tireur redeclenche indefiniment avec une seule arme. Avec le second,
   * il ne fait que rafraichir et il faut de nouveau l'autre element. Garde par
   * `room.test.ts` (« une reaction declenchee par un IMPACT est annoncee »).
   *
   * `by` suit le meme raisonnement : le champ appartient a qui l'a declenche,
   * si bien qu'une reaction ulterieure compare deux identites reellement
   * differentes au lieu de rejouer une charge deja comptee.
   */
  element: number;
  /**
   * L'identite de l'ennemi qui a declenche cette reaction — `undefined` pour
   * un recouvrement de zones (`onZoneCreated`), sans ennemi associe.
   *
   * ⚠️ **Ne sert QU'aux chaines, pour s'exclure d'elles-memes** : sans elle, le
   * premier saut, mesure depuis CET ennemi, le retrouverait a distance nulle.
   * Ne voyage jamais (absent de `ReactionEvent`/`ReactionMessage`).
   */
  entityId?: number;
}

/**
 * Les reactions declenchees pendant un tick, bornees par ennemi.
 *
 * ⚠️ **COLLECTEES pendant le tick et resolues a la fin, jamais au fil de
 * l'eau.** Resoudre tue, et tuer compacte la horde (`Horde.kill`) : le faire
 * depuis `markInZones` ou `Projectiles.collide` invaliderait les indices de la
 * boucle en cours. Un declencheur ne retient donc qu'une POSITION, jamais un
 * creneau.
 *
 * ⚠️ **La borne se compte par IDENTITE, pas par creneau** : la horde est
 * compactee entre le declenchement d'un projectile et celui d'une zone.
 *
 * ⚠️ La borne est par ENNEMI, pas par tick : une zone Givre sur vingt ennemis
 * marques Braise fait bien vingt reactions. Ce qu'elle empeche, c'est qu'un
 * ennemi rebondisse entre des zones d'elements alternes, autant de fois qu'il
 * y a de zones sur lui.
 */
/**
 * Ticks pendant lesquels un ennemi qui vient de reagir ne reagit plus (0,5 s).
 * Sans elle, deux armes d'elements differents qui remarquent le meme ennemi a
 * chaque pulsation (homoncule, halo, faisceau) le font reagir en boucle. Pendant
 * la recharge, le second element se contente de REMPLACER la marque.
 */
export const REACTION_COOLDOWN_TICKS = 15;

export class Reactions {
  #pending: ReactionTrigger[] = [];
  /**
   * Le tick de la derniere reaction de chaque identite, tant qu'elle est en
   * recharge (`REACTION_COOLDOWN_TICKS`). Englobe la borne « une par tick » :
   * un ecart de zero est sous la recharge.
   */
  readonly #lastReaction = new Map<number, number>();

  /** Nombre de reactions en attente de resolution. */
  get count(): number {
    return this.#pending.length;
  }

  /**
   * Declenche une reaction SUR un ennemi, si sa recharge le permet. Rend
   * `true` si la reaction a lieu : c'est ce qui dit a l'appelant si la marque
   * se consomme ou si le second element se contente de la remplacer.
   */
  onEntity(entityId: number, trigger: ReactionTrigger, tick = 0): boolean {
    const derniere = this.#lastReaction.get(entityId);
    if (derniere !== undefined && tick - derniere < REACTION_COOLDOWN_TICKS) {
      return false;
    }
    this.#lastReaction.set(entityId, tick);
    this.#pending.push(trigger);
    return true;
  }

  /**
   * Declenche les reactions dues a la zone qui vient d'etre CREEE dans le
   * creneau `created` : une par zone vivante d'un autre element dont le disque
   * coupe le sien.
   *
   * ⚠️ **`overlaps`, pas la regle de fusion.** Deux zones reagissent quand
   * leurs DISQUES sont secants (distance < `2 × ZONE_RADIUS`) ; la fusion a la
   * pose regarde si le CENTRE tombe dans une zone (distance < `ZONE_RADIUS`).
   * Confondre les deux ferait rater les recouvrements les plus francs.
   *
   * ⚠️ **A la creation seulement, jamais sur un rafraichissement** : sinon deux
   * zones qui se recouvrent reagiraient a CHAQUE tick, et une arme
   * elementaire entretient une zone par fusion, donc indefiniment. C'est ce
   * qui borne ce chemin, qui n'a pas d'ennemi pour la borne par ennemi.
   *
   * ⚠️ **Aucune zone n'est consommee.** La mort d'une zone n'est jamais
   * annoncee : le client la derive du seul `bornTick`, et le Givre RALENTIT.
   * Un serveur qui retirerait une zone que le client garde ferait diverger le
   * deplacement.
   */
  onZoneCreated(zones: ZoneField, created: number, tick: number): void {
    const element = zoneElement(zones.kind[created] ?? 0);
    const by = zones.by[created] ?? 0;
    for (let i = 0; i < zones.count; i++) {
      // Ni garde `i === created` (la zone porte forcement `element`, la
      // comparaison l'ecarte), ni garde `NEUTRE` (`postZone`, seul createur
      // de zones, ne pose jamais neutre) : une garde qu'aucun test ne peut
      // faire rougir est une garde qu'on croit avoir.
      const other = zoneElement(zones.kind[i] ?? 0);
      if (other === element) {
        continue;
      }
      if (!zones.aliveAt(i, tick) || !zones.overlaps(created, i)) {
        continue;
      }
      this.#pending.push({
        pair: packElementPair(other, element),
        // Le milieu des deux centres : la ou deux disques de meme rayon ont
        // leur corde commune, seul point que les deux zones designent.
        x: ((zones.x[i] ?? 0) + (zones.x[created] ?? 0)) / 2,
        y: ((zones.y[i] ?? 0) + (zones.y[created] ?? 0)) / 2,
        markBy: zones.by[i] ?? 0,
        by,
        // Le SECOND element, celui de la zone qui vient de naitre.
        element,
      });
    }
  }

  /**
   * Rend les reactions du tick et oublie les recharges ecoulees, pour que la
   * table ne garde que les ennemis qui ont reagi recemment (morts compris).
   */
  drain(tick?: number): ReactionTrigger[] {
    const out = this.#pending;
    this.#pending = [];
    if (tick !== undefined) {
      for (const [id, derniere] of this.#lastReaction) {
        if (tick - derniere >= REACTION_COOLDOWN_TICKS) {
          this.#lastReaction.delete(id);
        }
      }
    }
    return out;
  }
}

/**
 * Applique un element sur l'ennemi du creneau `slot` : **le seul endroit ou
 * les marques et les reactions sont decidees.**
 *
 * | Ce que porte l'ennemi | Ce qui arrive |
 * | --- | --- |
 * | rien (ou une marque perimee) | la marque se pose |
 * | le MEME element | la marque se rafraichit — **pas de reaction** |
 * | un AUTRE element | reaction, et la marque se CONSOMME |
 *
 * ⚠️ **Un ennemi ressort NU d'une reaction.** Poser le declencheur ferait de
 * deux zones d'elements opposes une machine a reactions.
 *
 * ⚠️ **En recharge, le second element remplace le premier.** Ni file, ni
 * reaction reportee : elle s'appliquerait a des positions qui ont bouge, et
 * une file croitrait avec la densite de la horde.
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
    const declenche = reactions.onEntity(
      horde.entityIdAt(slot),
      {
        pair: packElementPair(porte, element),
        x: horde.x[slot] ?? 0,
        y: horde.y[slot] ?? 0,
        markBy: horde.markBy[slot] ?? 0,
        by,
        element,
        entityId: horde.entityIdAt(slot),
      },
      tick,
    );
    if (declenche) {
      // `NEUTRE` n'est pas un cas particulier de la table des elements : le
      // reposer par le chemin normal suffit.
      horde.applyMark(slot, ELEMENT.NEUTRE, 0, tick);
      return;
    }
  }
  horde.applyMark(slot, element, by, tick);
}

/**
 * L'armure effective au tick `tick` : celle de l'archetype, moins la plus
 * forte reduction des champs de Supraconduction qui couvrent l'entite
 * (`ZoneField.armorReductionAt`, voir sa doc pour le maximum), puis l'aura du
 * chaman. Une derivation, pas un etat : rien a faire voyager.
 *
 * ⚠️ **Bornee a zero, jamais negative** (`capArmor` la borne par le haut) :
 * `brut x amp x (1 - armure)` ne doit jamais depasser `brut x amp`.
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
        hurtPlayer(p, KAMIKAZE_PLAYER_DAMAGE);
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
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * **Le seul chemin par lequel un ennemi perd des PV** : aucun
 * `horde.hp[...] -=` ailleurs dans le depot (un `grep` le verifie). Deux
 * formules d'armure divergeraient sans qu'un bug se voie.
 *
 * Retire `brut x amp x (1 - armure)` a l'entite du creneau `slot`, et note son
 * identite dans `dead` si elle n'y survit pas.
 *
 * ⚠️ **L'amplification (`ZoneField.ampAt`) et l'armure (`armureA`) sont
 * DERIVEES ICI**, jamais passees tout calculees par les appelants. Seul le
 * serveur les utilise : elles echappent a la contrainte de replication du
 * ralentissement (voir `ZoneField.ampAt`).
 *
 * ⚠️ **NE TUE PAS** : tuer compacte la horde et invaliderait les creneaux de
 * la boucle de l'appelant. `Horde.kill` reste dehors, apres tous les degats.
 *
 * `Set` ou tableau : les projectiles dedoublonnent (deux impacts peuvent
 * achever la meme entite, et `DEATHS` exige des identites uniques) ; la
 * combustion balaie chaque creneau une fois et n'a pas besoin du `Set`.
 *
 * ⚠️ **La borne `<= 0` ne se distingue de `< 0` que par les degats ENTIERS**
 * (projectiles, reactions) sur une armure nulle. La combustion retire 0,1,
 * non representable en `Float32Array` : elle ne tombe jamais pile sur zero.
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
  // ⚠️ **AUCUN arrondi sur ce chemin.** `Horde.hp` est un `Float32Array` et
  // la combustion retire 0,1 par tick : un `Math.round` avalerait
  // l'empilement des passifs de degats.
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
 * ennemi dont le centre tombe a moins de `radius` de `(cx, cy)` — et, si
 * `markFilter` est fourni, dont la marque COURANTE vaut cette valeur — puis
 * note dans `dead` ceux qui n'y survivent pas.
 *
 * Trois appelants, une seule geometrie : la reaction generique
 * (`REACTION_DAMAGE`), l'explosion d'une arme de zone (`Weapon.blastRadius`)
 * et l'Embrasement (`markFilter = ELEMENT.POIX`). Un second balayage
 * divergerait a la premiere retouche : un filtre de plus est un parametre,
 * pas une fonction.
 *
 * Le filtre exclut de lui-meme l'ennemi qui a declenche Embrasement : sa
 * marque de Poix vient d'etre consommee par `applyElement`.
 *
 * ⚠️ **Un rayon, jamais une propagation de proche en proche** : un parcours de
 * graphe dependrait de l'ordre de visite, rien ne departageant a distance
 * egale.
 *
 * ⚠️ **NE TUE PAS** : tuer compacte la horde et invaliderait les indices de la
 * boucle de l'appelant (`applyReactions`, `Projectiles.collide`).
 *
 * ⚠️ **Borne STRICTE (`< radius`)**, comme `markInZones` et
 * `ZoneField.slowsAt` : une entite pile sur le cercle n'est pas touchee.
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
    // ⚠️ **L'amplification est PAR ENTITE, pas par point d'impact** :
    // `appliquerDegats` lit la position de CHACUN. Deriver le facteur une fois
    // pour le centre serait plus rapide et faux.
    appliquerDegats(horde, i, damage, zones, tick, dead);
  }
}

/**
 * Court-circuit (Foudre + Poix) : `chainTargets` (`shared/chain.ts`, la meme
 * fonction que la chaine de Foudre) sur la seule population POISSEE.
 *
 * `chainTargets` choisit le plus proche NON EXCLU : en horde dense, ce serait
 * presque toujours un voisin sain. D'ou `exclude` pre-rempli de tous les
 * non-poisses : chaque saut est poisse PAR CONSTRUCTION, et la chaine saute
 * PAR-DESSUS les sains plutot que de s'y arreter.
 *
 * ⚠️ **Exclut aussi `t.entityId` et `dead`.** Pas redondant : un ennemi qui
 * vient de reagir ressort NU, mais un projectile de Foudre reagit dans
 * `resolveProjectileDamage`, AVANT `markInZones` ; s'il se tient dans une
 * flaque de Poix, il est remarque Poix avant que ce declencheur soit resolu,
 * et relancerait sa propre chaine sur lui-meme.
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
  // Garde de type : `id` vient toujours de `horde.entityIdAt`, aucun test ne
  // peut la separer de son absence.
  if (trigger.entityId !== undefined) {
    exclude.add(trigger.entityId);
  }
  // Pre-remplissage : chaque saut poisse PAR CONSTRUCTION.
  for (let i = 0; i < horde.count; i++) {
    if (horde.markAt(i, tick) !== ELEMENT.POIX) {
      exclude.add(horde.entityIdAt(i));
    }
  }
  // ⚠️ **`COURT_CIRCUIT_MAX_JUMPS`, jamais `horde.count`** : une borne de
  // COUT (voir sa doc), pas une regle de jeu. Sans elle, `chainTargets`
  // construit la liste entiere et un seul Court-circuit fait sauter le budget
  // du tick a N = 1 000.
  const jumps = Math.min(horde.count, COURT_CIRCUIT_MAX_JUMPS);
  for (const id of chainTargets(horde, trigger.x, trigger.y, CHAIN_RADIUS, jumps, exclude)) {
    const slot = horde.slotOf(id);
    // Inatteignable : `chainTargets` ne rend que des identites lues DANS
    // `horde`, et rien ne compacte entre cet appel et cette boucle.
    if (slot < 0) {
      continue;
    }
    // Pas de controle `markAt` : le pre-remplissage garantit deja que `id`
    // est poisse.
    appliquerDegats(horde, slot, damage, zones, tick, dead);
  }
}

/**
 * Paratonnerre (Foudre + Vif-argent) : la chaine de Foudre ORDINAIRE
 * (`CHAIN_JUMPS`, `CHAIN_RADIUS`), restreinte aux ennemis LIES au
 * declencheur — meme forme que `chainWhilePoisoned`, `exclude` pre-rempli de
 * tout ce qui n'est pas lie. `jumps` est deja petit : pas de plafond de cout.
 *
 * Aucun ennemi lie (ou pas d'identite de declencheur) : toute la horde est
 * exclue, `chainTargets` rend une liste VIDE, sans boucler ni lever.
 *
 * La liaison se relit ici (`linkedNeighbours`, qui lit
 * `ReactionDef.zoneVifArgent`), y compris sur la zone que CE declencheur vient
 * de poser (`postZone`, avant cette fonction) : Paratonnerre porte
 * `zoneVifArgent: true`, donc sa zone lie tout voisin a moins de
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
  // Pre-remplissage : chaque saut LIE PAR CONSTRUCTION.
  for (let i = 0; i < horde.count; i++) {
    const id = horde.entityIdAt(i);
    if (!linked.has(id)) {
      exclude.add(id);
    }
  }
  for (const id of chainTargets(horde, trigger.x, trigger.y, CHAIN_RADIUS, CHAIN_JUMPS, exclude)) {
    const slot = horde.slotOf(id);
    // Inatteignable, comme dans `chainWhilePoisoned`.
    if (slot < 0) {
      continue;
    }
    appliquerDegats(horde, slot, damage, zones, tick, dead);
  }
}

/**
 * Amalgame (Poix + Vif-argent) : « les degats subis par un ennemi lie frappent
 * aussi ses voisins » — frappe l'ennemi qui declenche, PUIS chacun de ses
 * voisins LIES (`linkedNeighbours`), avec le MEME degat, une fois chacun. Ni
 * rayon ni chaine : `linkedNeighbours` est toute sa geometrie.
 *
 * ⚠️ **UN SEUL niveau, JAMAIS une cascade, par CONSTRUCTION** : chaque voisin
 * recoit `appliquerDegats` directement, qui ne consulte aucune liaison. A lie
 * a B lie a C : un coup sur A touche B, jamais C (test « Amalgame ne se
 * propage pas en cascade », `combat.test.ts`).
 *
 * ⚠️ **Le partage reste propre a Amalgame, jamais une propriete
 * d'`appliquerDegats`** : la Vaporisation balaie un rayon centre sur CHAQUE
 * lie, et un `appliquerDegats` qui cascaderait compterait chacun deux fois.
 *
 * La liaison peut venir de la zone que CETTE reaction vient de poser
 * (`postZone`, avant cette fonction) : Amalgame porte `zoneVifArgent: true`.
 *
 * Sans identite de declencheur (recouvrement de zones), aucun degat.
 *
 * `dead` est le MEME `Set` que celui d'`applyReactions` : deux lies qui
 * meurent du meme Amalgame n'y figurent qu'une fois chacun.
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
    // Inatteignable, comme dans `chainWhilePoisoned`.
    if (linkedSlot < 0) {
      continue;
    }
    // Un seul appel direct, jamais `shareAmalgameDamage` : UN SEUL niveau.
    appliquerDegats(horde, linkedSlot, damage, zones, tick, dead);
  }
}

/**
 * Resout les reactions collectees pendant le tick : l'effet SPECIFIQUE de la
 * table (`shared/reactions.ts`) si la paire en a un, sinon `REACTION_DAMAGE` a
 * tout ennemi dans `REACTION_RADIUS` du point — et rend les identites de ceux
 * qui en meurent.
 *
 * ⚠️ **Un lookup dans la table, jamais un `switch` sur `pair`** :
 * `reactionForPair` est le SEUL endroit qui connaisse la valeur numerique
 * d'un couple ; on ne branche que sur `ReactionDef.id`.
 *
 * ⚠️ **Les morts passent par le `DEATHS` EXISTANT** : `Room.step` les fusionne
 * avec celles des projectiles et des brulures, car
 * `GameClient#drainPendingDeaths` suppose un seul lot par tick.
 *
 * ⚠️ **Les champs se posent d'abord, tous, puis les degats, puis la
 * compaction.** Deux reactions voisines doivent voir la meme reserve de zones
 * que si elles etaient seules (la regle de fusion a besoin de l'etat
 * complet). Tuer entre deux reactions ferait choisir les voisins de la
 * seconde par l'ordre du tableau plutot que par la geometrie.
 *
 * L'ennemi qui a declenche n'a pas de traitement a part : a distance nulle du
 * point, il est dans le rayon.
 *
 * `zones` et `reactions` ne sont PAS optionnels : aucun appelant legitime ne
 * resout une reaction sans laisser son champ, ni ne pose une zone sans
 * arbitrer le couple qu'elle forme avec ses voisines.
 *
 * ⚠️ **Echo : `echoOf(t.by)` multiplie les degats INSTANTANES de la reaction**
 * (balayage, chaine ou cible unique), pas les champs au sol. Le DECLENCHEUR
 * (`by`), jamais le marqueur (`markBy`). Serveur seul, aucun octet de plus.
 */
export function applyReactions(
  horde: Horde,
  orbs: OrbField,
  tick: number,
  triggers: readonly ReactionTrigger[],
  zones: ZoneField,
  reactions: Reactions,
  echoOf: (playerId: number) => number = () => 0,
): number[] {
  for (const t of triggers) {
    postZone(zones, t, tick, reactions);
  }

  const dead = new Set<number>();
  for (const t of triggers) {
    const def = reactionForPair(t.pair);
    const echo = 1 + echoOf(t.by);
    if (def?.id === REACTION.EMBRASEMENT) {
      // `damageInRadius` filtre par la Poix.
      damageInRadius(
        horde,
        t.x,
        t.y,
        def.radius,
        def.damage * echo,
        zones,
        tick,
        dead,
        ELEMENT.POIX,
      );
    } else if (def?.id === REACTION.COURT_CIRCUIT) {
      // `def.damage` vaut ici `REACTION_DAMAGE`, mais on garde la LECTURE :
      // `combat.test.ts` asserte la perte de PV exacte, par saut.
      chainWhilePoisoned(horde, t, def.damage * echo, zones, tick, dead);
    } else if (def?.id === REACTION.ECLAT_DE_GEL) {
      // ⚠️ **Une SEULE cible, jamais un balayage** : `def.radius` vaut 0, et
      // `damageInRadius` (borne stricte) ne toucherait personne. La cible est
      // l'ennemi qui declenche ; sans lui (recouvrement de zones), rien.
      const slot = t.entityId !== undefined ? horde.slotOf(t.entityId) : -1;
      if (slot >= 0) {
        appliquerDegats(horde, slot, def.damage * echo, zones, tick, dead);
      }
    } else if (def?.id === REACTION.VAPORISATION) {
      // Vaporisation (Braise + Vif-argent) : degats en RAYON autour de CHAQUE
      // ennemi LIE au declencheur.
      //
      // ⚠️ **Aucun `markFilter`** : il exclurait a tort le declencheur, qui
      // ressort NU, des rayons de ses propres lies.
      //
      // Sans identite de declencheur, aucun degat. Avec, la zone que
      // `postZone` vient de poser (Vaporisation porte `zoneVifArgent: true`)
      // suffit a lier tout voisin a moins de `ZONE_RADIUS` du point d'impact.
      const slot = t.entityId !== undefined ? horde.slotOf(t.entityId) : -1;
      if (slot >= 0) {
        for (const linkedId of linkedNeighbours(horde, slot, zones, tick)) {
          const linkedSlot = horde.slotOf(linkedId);
          // Inatteignable, comme dans `chainWhilePoisoned`.
          if (linkedSlot < 0) {
            continue;
          }
          damageInRadius(
            horde,
            horde.x[linkedSlot] ?? 0,
            horde.y[linkedSlot] ?? 0,
            def.radius,
            def.damage * echo,
            zones,
            tick,
            dead,
          );
        }
      }
    } else if (def?.id === REACTION.ARC_CAUSTIQUE) {
      // Arc caustique (Foudre + Chaux) : la chaine de Foudre ordinaire, PLUS
      // un champ corrosif a CHAQUE cible touchee, par `postZone` (seul
      // createur de zones).
      const exclude = new Set(dead);
      if (t.entityId !== undefined) {
        exclude.add(t.entityId);
      }
      for (const id of chainTargets(horde, t.x, t.y, CHAIN_RADIUS, CHAIN_JUMPS, exclude)) {
        const slot = horde.slotOf(id);
        if (slot < 0) {
          continue;
        }
        appliquerDegats(horde, slot, def.damage * echo, zones, tick, dead);
        // Le champ SUIT la cible : seule la position change.
        postZone(zones, { ...t, x: horde.x[slot] ?? 0, y: horde.y[slot] ?? 0 }, tick, reactions);
      }
    } else if (def?.id === REACTION.PARATONNERRE) {
      chainPreferringLinked(horde, t, def.damage * echo, zones, tick, dead);
    } else if (def?.id === REACTION.AMALGAME) {
      shareAmalgameDamage(horde, t, def.damage * echo, zones, tick, dead);
    } else {
      damageInRadius(horde, t.x, t.y, REACTION_RADIUS, REACTION_DAMAGE * echo, zones, tick, dead);
    }
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Etape 8 de la sequence serveur : avance les projectiles, resout les
 * collisions, tue les entites touchees et fait apparaitre leurs orbes — dans
 * cet ordre, pour que l'orbe capture la position du monstre AVANT sa
 * compaction par `Horde.kill`. Rend les identites mortes ce tick (DEATHS).
 *
 * ⚠️ **Le `Set` de deduplication est indispensable** : deux impacts (ou une
 * explosion et un tir) qui achevent la meme entite au meme tick passent tous
 * deux par `reste <= 0`. Sans lui, l'identite partirait deux fois dans
 * `DEATHS`, qui exige des identites uniques et triees, et `Horde.kill`
 * supprimerait l'entite VIVANTE deplacee dans le creneau.
 *
 * Une arme dont `blastRadius` est non nul frappe tout ce qui entoure l'ennemi
 * percute, par `damageInRadius`.
 *
 * ⚠️ **L'explosion ne MARQUE que l'ennemi percute**, pas le rayon : sinon
 * chaque grenade serait un declencheur de masse, que la borne par ennemi ne
 * limite pas.
 *
 * La Foudre chaine depuis l'ennemi PERCUTE : chaque cible recoit
 * `appliquerDegats`, et ses morts rejoignent le meme `dead`.
 */
export function resolveProjectileDamage(
  projectiles: Projectiles,
  dt: number,
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
  reactions?: Reactions,
  venins?: Venins,
  // Ou est chaque tireur : l'orbite tourne autour, le boomerang y revient.
  // Sans elle, ils se rabattent sur leur point d'emission.
  anchor?: Anchor,
): number[] {
  // Un projectile ne laisse rien au sol : il MARQUE ce qu'il touche, et ce
  // sont les reactions qui posent les champs.
  const dead = new Set<number>();
  // ⚠️ **Une arme de zone explose AUSSI en fin de course**, meme sans avoir
  // touche personne, par le meme balayage qu'a l'impact. Rien pour les armes
  // sans souffle.
  projectiles.step(
    dt,
    (slot) => {
      const souffle = projectiles.blastRadiusAt(slot);
      if (souffle <= 0) {
        return;
      }
      const x = projectiles.x[slot] ?? 0;
      const y = projectiles.y[slot] ?? 0;
      damageInRadius(
        horde,
        x,
        y,
        souffle,
        // Le critique vaut aussi ici : son tirage date de l'emission.
        projectiles.damageAt(slot) * projectiles.critFactorAt(slot),
        zones,
        tick,
        dead,
      );
      // ⚠️ **Et il MARQUE le plus proche** (regle du halo) : le Chaudron a
      // poix ne percute rien en vol, sans cette ligne il ne poserait jamais
      // la Poix.
      marquePlusProche(
        horde,
        reactions,
        {
          x,
          y,
          radius: souffle,
          element: projectiles.elementAt(slot),
          by: projectiles.ownerAt(slot),
        },
        tick,
        dead,
      );
    },
    horde,
    anchor,
  );

  // `zones, tick` en dernier : rayon de touche elargi du Vif-argent, COTE
  // SERVEUR SEUL (voir `ZoneField.hitRadiusBonusAt`). Le client appelle
  // `collide` sans eux et garde le rayon de base.
  projectiles.collide(
    horde,
    (entityId, damage, projectileSlot) => {
      const element = projectiles.elementAt(projectileSlot);
      const by = projectiles.ownerAt(projectileSlot);
      const slot = horde.slotOf(entityId);
      if (slot < 0) {
        // Inatteignable : `collide` ne rend que des identites lues dans la
        // horde, et la seule compaction est le `horde.kill` final. Aucun test
        // ne la garde ; gardee car `horde.hp[-1] = ...` serait un no-op
        // SILENCIEUX si un appelant futur compactait entre les deux.
        return;
      }
      // Le neutre amplifie ce que l'equipe a marque (`NEUTRE_MARQUE_AMP`). Lu
      // AVANT les degats : la marque est celle que le tir trouve en arrivant.
      const ampNeutre =
        element === ELEMENT.NEUTRE && horde.markAt(slot, tick) !== ELEMENT.NEUTRE
          ? NEUTRE_MARQUE_AMP
          : 1;
      // ⚠️ **Le critique MULTIPLIE, il ne remplace pas** : il se compose avec
      // l'amplification du neutre et celle des flaques. Son tirage date de
      // l'EMISSION (`Projectiles.critAt`) : le client a deja affiche le meme.
      const coup = damage * ampNeutre * projectiles.critFactorAt(projectileSlot);
      const blastRadius = projectiles.blastRadiusAt(projectileSlot);
      if (blastRadius > 0) {
        // ⚠️ **Le centre est l'ennemi PERCUTE, pas le projectile** : `collide`
        // teste le segment du pas, le projectile peut avoir depasse sa cible.
        //
        // L'ennemi percute n'a PAS de traitement a part : a distance nulle du
        // centre, il est dans le rayon. Lui retirer `damage` en plus lui
        // infligerait le double.
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
        // Tir simple : chemin DIRECT, pour le cout. `damageInRadius` est en
        // O(horde) par impact, et le lance-flammes tire tres vite.
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
        // ⚠️ **Un ennemi qui meurt (de cet impact ou d'une explosion du meme
        // tick) n'est pas marque** : sans ce `return`, `applyElement`
        // declencherait une reaction sur le mourant. Garde par « un ennemi qui
        // MEURT du meme impact ne reagit pas » (`combat.test.ts`).
        return;
      }
      // Le venin (carte d'arme) : une part du coup revient en poison sur la
      // duree. Un mort n'en recoit pas — le `return` ci-dessus l'a deja ecarte.
      const venom = projectiles.venomAt(projectileSlot);
      if (venins && venom > 0) {
        venins.add(entityId, coup * venom);
      }
      if (element !== ELEMENT.NEUTRE) {
        // Marque, ou reaction si l'ennemi porte un AUTRE element.
        applyElement(horde, reactions, slot, element, by, tick);
        if (element === ELEMENT.FOUDRE) {
          // ⚠️ **La chaine de Foudre se derive d'un POINT D'IMPACT**, pas
          // d'une marque : elle se declenche ici, au site qui reconnait
          // l'element.
          //
          // Exclus : l'entite PERCUTEE (sinon le premier saut la retrouve a
          // distance nulle) et `dead` (un voisin deja tue par ce meme tick ne
          // recoit pas un second coup). `chainTargets` copie `exclude`.
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
            // Inatteignable, comme le `slot < 0` plus haut.
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
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Une pulsation de halo, deja resolue (point, rayon, degat) par
 * `Room#fireOne`, qui tient les reglages de toutes les familles : les
 * recopier ici en ferait une seconde definition de « quand et combien ».
 */
export interface HaloPulse {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly damage: number;
  /** L'element porte par le halo, `ELEMENT.NEUTRE` s'il n'en porte aucun. */
  readonly element: number;
  /** Le joueur a qui ce halo appartient — c'est LUI que la marque retient. */
  readonly by: number;
}

/**
 * Marque le plus proche VIVANT du centre dans le rayon — la regle de marque de
 * toute source de zone (halo, invocation, frappe, souffle de fin de course) :
 * voir `resolveHalos` pour le pourquoi d'une seule marque.
 */
function marquePlusProche(
  horde: Horde,
  reactions: Reactions | undefined,
  zone: Omit<HaloPulse, 'damage'>,
  tick: number,
  dead: ReadonlySet<number>,
): void {
  if (zone.element === ELEMENT.NEUTRE || !reactions) {
    return;
  }
  let bestSlot = -1;
  let bestDist2 = Number.POSITIVE_INFINITY;
  const r2 = zone.radius * zone.radius;
  for (let i = 0; i < horde.count; i++) {
    if (dead.has(horde.entityIdAt(i))) {
      continue;
    }
    const dx = (horde.x[i] ?? 0) - zone.x;
    const dy = (horde.y[i] ?? 0) - zone.y;
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
    applyElement(horde, reactions, bestSlot, zone.element, zone.by, tick);
  }
}

/**
 * Le halo : a chaque pulsation, tout ce qui se tient dans le rayon encaisse,
 * par le balayage commun (`damageInRadius`).
 *
 * ⚠️ **Il ne MARQUE que le plus proche VIVANT, pas tout le rayon**, comme
 * l'arme de zone. Marquer quarante ennemis d'un coup ferait quarante
 * reactions donc quarante zones (`ZONE_CAPACITY` vaut 128, recouvrement en
 * O(zones²)) : la reaction doit rester RARE. Marquer un mourant declencherait
 * une reaction sur quelqu'un qui n'est plus la.
 *
 * Rend les identites mortes, comme `resolveBurn` et `resolveProjectileDamage`.
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
    marquePlusProche(horde, reactions, pulse, tick, dead);
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * L'onde : chaque onde vivante frappe les ennemis de la bande qu'elle balaie a
 * ce tick (`ondeBand`) — chacun une fois par onde, sans ensemble a tenir,
 * puisque les bandes de deux ticks se touchent sans se recouvrir.
 *
 * Meme discipline que `resolveHalos` : `appliquerDegats`, une seule marque
 * (le plus proche VIVANT parmi ceux touches a ce tick), morts et orbes
 * prononces ici. Ne purge rien : `Room` oublie les ondes eteintes.
 */
export function resolveOndes(
  ondes: readonly Onde[],
  horde: Horde,
  orbs: OrbField,
  tick: number,
  zones: ZoneField,
  reactions?: Reactions,
): number[] {
  if (ondes.length === 0) {
    return [];
  }
  const dead = new Set<number>();
  for (const onde of ondes) {
    const band = ondeBand(onde, tick);
    if (band === null) {
      continue;
    }
    const in2 = band.inner < 0 ? -1 : band.inner * band.inner;
    const out2 = band.outer * band.outer;
    let bestSlot = -1;
    let bestDist2 = Number.POSITIVE_INFINITY;
    for (let i = 0; i < horde.count; i++) {
      const dx = (horde.x[i] ?? 0) - onde.x;
      const dy = (horde.y[i] ?? 0) - onde.y;
      const d2 = dx * dx + dy * dy;
      // Comparees au carre : `(inner, outer]` comme `ondeStrikes`, sans racine.
      if (d2 <= in2 || d2 > out2) {
        continue;
      }
      appliquerDegats(horde, i, onde.damage, zones, tick, dead);
      if (d2 < bestDist2 && !dead.has(horde.entityIdAt(i))) {
        bestDist2 = d2;
        bestSlot = i;
      }
    }
    if (bestSlot >= 0 && onde.element !== ELEMENT.NEUTRE && reactions) {
      applyElement(horde, reactions, bestSlot, onde.element, onde.by, tick);
    }
  }
  if (dead.size === 0) {
    return [];
  }
  const deadIds = [...dead];
  for (const id of deadIds) {
    const slot = horde.slotOf(id);
    if (slot >= 0) {
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Un trait de faisceau, deja resolu par `Room#fireOne` comme `HaloPulse` :
 * une geometrie et un degat.
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
 * Le faisceau : tout ce qui touche le trait encaisse, du porteur jusqu'au bout
 * de sa portee. Geometrie des projectiles (`distanceToSegmentSquared`).
 *
 * ⚠️ **Il ne MARQUE que le plus proche**, comme le halo (voir `resolveHalos`).
 * « Le plus proche » se mesure depuis le PORTEUR : c'est le premier corps que
 * le rayon rencontre.
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
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(deadIds);
  return deadIds;
}

/**
 * Etape 9 de la sequence serveur : arbitre le contact entre les joueurs et
 * la horde — hitbox genereuse, en faveur du joueur, avec une fenetre
 * d'invulnerabilite apres chaque touche.
 *
 * ⚠️ **`contactInvulnTicks` est ce qui empeche une mort en une seconde** : un
 * coup tous les `CONTACT_INTERVAL_TICKS` au lieu d'un par tick, quel que soit
 * le nombre de monstres au contact. L'invulnerabilite est PAR JOUEUR, pas par
 * paire joueur/monstre.
 *
 * Modifie `players` EN PLACE (hp, contactInvulnTicks).
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
      hurtPlayer(player, CONTACT_DAMAGE);
      player.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
    }
  }
}

/**
 * Contagion : la marque d'un ennemi qui meurt passe au vivant le plus proche,
 * AVEC son auteur. `fallen` vient d'`OrbField.drainFallen()` : des positions
 * ABSOLUES et des marques deja resolues, car au moment ou `Room#step` appelle
 * ceci, les chemins de mort ont deja compacte la horde (voir
 * `OrbField.#fallen`, qui explique aussi pourquoi `markBy` voyage avec
 * `mark`).
 *
 * ⚠️ **Une seule passe, pas de cascade.** Une marque transmise ne se
 * retransmet pas au meme tick : sinon une vague de morts repeindrait la horde
 * entiere d'un coup, et le cout serait quadratique.
 */
export function spreadMarkOnDeath(horde: Horde, fallen: readonly number[], tick: number): void {
  for (let i = 0; i + 3 < fallen.length; i += 4) {
    const x = fallen[i] ?? 0;
    const y = fallen[i + 1] ?? 0;
    const mark = fallen[i + 2] ?? ELEMENT.NEUTRE;
    const markBy = fallen[i + 3] ?? 0;
    if (mark === ELEMENT.NEUTRE) {
      continue;
    }
    let meilleur = -1;
    let d2 = CONTAGION_RADIUS * CONTAGION_RADIUS;
    for (let slot = 0; slot < horde.count; slot++) {
      if ((horde.hp[slot] ?? 0) <= 0) {
        continue;
      }
      const dx = (horde.x[slot] ?? 0) - x;
      const dy = (horde.y[slot] ?? 0) - y;
      const d = dx * dx + dy * dy;
      if (d < d2) {
        d2 = d;
        meilleur = slot;
      }
    }
    if (meilleur >= 0) {
      // L'element ET son auteur, jamais `0` : voir `OrbField.#fallen`.
      horde.applyMark(meilleur, mark, markBy, tick);
    }
  }
}

/**
 * Un `ContactPlayer` plus son identite : la charge ne blesse **qu'une fois par
 * joueur et par charge**, il faut savoir lesquels ont deja ete touches.
 */
export interface ChargeTarget extends ContactPlayer {
  readonly id: number;
}

/**
 * Applique les degats de la charge du boss au tick `tick`, et rend les
 * identites des joueurs touches CE tick-ci.
 *
 * ⚠️ **Arbitre par le serveur, comme tout ce qui fait mal.** Le client derive
 * la POSITION du boss, jamais un degat.
 *
 * ⚠️ **Rien ne fait mal pendant le chargement** (`chargeHurtsAt`) : c'est la
 * fenetre de reaction du joueur.
 *
 * ⚠️ **Une seule fois par joueur et par charge**, d'ou `alreadyHit`. Sans
 * elle, un joueur immobile dans le couloir encaisserait `BOSS_CHARGE_DAMAGE` a
 * chaque tick de la traversee : une execution, plus une attaque.
 *
 * ⚠️ **Le corps qui blesse est un DISQUE de diametre `charge.width`, pas le
 * rectangle annonce** (qui dit ou le boss VA passer). Un joueur qui traverse
 * le couloir derriere le boss n'est pas touche.
 *
 * ⚠️ **Lit la position dans la HORDE** : un boss mort en pleine charge cesse
 * de blesser au meme tick que `Horde#applyCharge` cesse de le deplacer.
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
    hurtPlayer(player, BOSS_CHARGE_DAMAGE);
    // Le corps du boss reste sur lui le temps de le traverser : sans ce
    // rearmement, `resolveContact` le blesserait encore au tick suivant.
    player.contactInvulnTicks = CONTACT_INTERVAL_TICKS;
    hit.push(player.id);
  }
  return hit;
}

/**
 * Pose le champ que laisse une reaction, a son point d'application — creation,
 * ou rafraichissement de celui qui couvre deja le point (la regle de fusion
 * qui BORNE le nombre de zones).
 *
 * ⚠️ **C'est le SEUL createur de zones** : les zones ne naissent que d'une
 * combinaison d'elements, jamais d'un tir. Les bornes (fusion,
 * `ZONE_CAPACITY`, `ZONE_REFRESH_INTERVAL_TICKS`) restent pour les reactions
 * en chaine ; `bench/zones.bench.ts` mesure le budget.
 *
 * ⚠️ **Les coordonnees sont ARRONDIES**, comme les positions de joueurs avant
 * le flowfield. Le message `ZONE` ne transporte que des `int16` : si le
 * serveur gardait le flottant, le predicat `dx² + dy² < ZONE_RADIUS²` du
 * ralentissement divergerait entre les deux cotes pour les entites pile sur
 * le bord.
 *
 * Pas de garde « element neutre » : un declencheur ne nait jamais d'un
 * element neutre, donc aucune zone neutre ne peut exister.
 */
function postZone(
  zones: ZoneField,
  trigger: ReactionTrigger,
  tick: number,
  reactions: Reactions,
): void {
  // ⚠️ **Le compte AVANT la pose distingue creation et rafraichissement** :
  // `spawn` rend le creneau touche dans les deux cas, et deux zones ne
  // reagissent qu'a la creation de la seconde. Sinon deux reactions repetees
  // au meme endroit reagiraient a chaque fois, indefiniment.
  // Une paire absente de la table (Choc thermique generique) empaquete
  // `REACTION.AUCUNE` (0), et `packZoneKind(element, 0) === element`.
  const reactionId = reactionForPair(trigger.pair)?.id ?? REACTION.AUCUNE;
  const avant = zones.count;
  const creneau = zones.spawn(
    packZoneKind(trigger.element, reactionId),
    Math.round(trigger.x),
    Math.round(trigger.y),
    trigger.by,
    tick,
  );
  // Pas de `creneau >= 0` : `spawn` ne rend `-1` que reserve pleine, sans
  // rien creer, et la comparaison des comptes le couvre deja.
  //
  // ⚠️ **Les declencheurs nes ici tombent dans le lot du tick SUIVANT**, et
  // c'est voulu : `Room.step` a deja draine celui-ci, et `applyReactions`
  // balaie encore la horde par creneau.
  if (zones.count > avant) {
    reactions.onZoneCreated(zones, creneau, tick);
  }
}

/**
 * Marque tout ennemi qui se trouve DANS une zone, et rafraichit la marque
 * tant qu'il y reste.
 *
 * O(zones x entites), comme `Horde#computeSlow`, mais **serveur seul** : la
 * marque ne voyage pas, c'est elle qui arbitre.
 *
 * `aliveAt`, pas `slowsAt` : c'est le predicat qui dit si la zone EXISTE.
 * Les zones naissent de `applyReactions`, APRES ce balayage : une zone posee
 * au tick `T` marque a `T + 1`, comme elle ralentit a `T + 1`. Voir
 * `ZoneField.slowsAt`.
 *
 * ⚠️ **Un ennemi couvert par une zone d'un AUTRE element que sa marque
 * REAGIT** (`applyElement`). La borne par ennemi vit dans `Reactions` : ce
 * balayage traverse un ennemi plusieurs fois par tick des que deux zones se
 * chevauchent.
 *
 * `reactions` n'est PAS optionnel : marquer par zone sans arbitrer les
 * reactions les desactiverait en silence.
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
 * Le poison que les cartes « venin » posent sur les ennemis, cote SERVEUR
 * seul.
 *
 * Chaque ennemi porte une RESERVE : un impact y ajoute `coup x Weapon.venom`,
 * chaque tick en retire une fraction fixe (`VENOM_DRAIN_PER_TICK`). La
 * reserve s'ecoule en entier, d'autant plus vite qu'elle est pleine.
 *
 * ⚠️ **Une reserve, pas une duree rafraichie** : une arme rapide qui
 * rafraichit un « poison de N par seconde » ne s'arreterait jamais de
 * cumuler. Ici dix petits coups et un gros coup de meme total empoisonnent
 * pareil.
 *
 * Indexee par IDENTITE, jamais par creneau (la horde compacte a chaque mort).
 * Hors de `Horde` : le client ne simule pas le poison.
 */
export class Venins {
  #reserve = new Map<number, number>();

  add(entityId: number, amount: number): void {
    this.#reserve.set(entityId, (this.#reserve.get(entityId) ?? 0) + amount);
  }

  /** Reserve restante de cet ennemi, `0` s'il n'est pas empoisonne. */
  reserveOf(entityId: number): number {
    return this.#reserve.get(entityId) ?? 0;
  }

  get size(): number {
    return this.#reserve.size;
  }

  /**
   * Un tick de poison : retire a chaque ennemi empoisonne sa part de reserve,
   * par `appliquerDegats` — donc armure et amplification comme tout degat.
   * Rend les identites mortes, compactees, orbes posees : meme contrat que
   * `resolveBurn`.
   */
  resolve(horde: Horde, orbs: OrbField, tick: number, zones: ZoneField): number[] {
    const dead: number[] = [];
    if (this.#reserve.size === 0) {
      return dead;
    }
    // ⚠️ **Un seul balayage de la horde, jamais `slotOf` par empoisonne**
    // (`slotOf` est lui-meme un balayage). Ce qui n'est pas revu ici (mort,
    // sorti de la horde, reserve soldee) tombe de la nouvelle table.
    const next = new Map<number, number>();
    for (let slot = 0; slot < horde.count; slot++) {
      const id = horde.entityIdAt(slot);
      const reserve = this.#reserve.get(id);
      if (reserve === undefined || reserve < VENOM_MIN_RESERVE) {
        continue;
      }
      const dose = Math.max(reserve * VENOM_DRAIN_PER_TICK, Math.min(reserve, VENOM_MIN_RESERVE));
      const before = dead.length;
      appliquerDegats(horde, slot, dose, zones, tick, dead);
      if (dead.length > before) {
        // Pas encore compacte : le creneau est toujours le sien.
        orbs.spawn(
          id,
          horde.x[slot] ?? 0,
          horde.y[slot] ?? 0,
          horde.markAt(slot, tick),
          horde.markBy[slot] ?? 0,
        );
      } else if (reserve - dose >= VENOM_MIN_RESERVE) {
        next.set(id, reserve - dose);
      }
    }
    this.#reserve = next;
    if (dead.length > 0) {
      horde.kill(dead);
    }
    return dead;
  }
}

/**
 * Part de la reserve de poison infligee a chaque tick : la reserve tombe a
 * moitie en ~0,7 s, et l'essentiel s'ecoule en 2 a 3 s.
 */
export const VENOM_DRAIN_PER_TICK = 1 / 30;
/** En dessous, la reserve est soldee d'un coup — sans quoi elle ne s'eteindrait jamais. */
export const VENOM_MIN_RESERVE = 0.1;

/**
 * La Braise brule : applique `Element.burnPerTick` a chaque ennemi dont la
 * marque tient encore, PUIS les zones de Surchauffe brulent d'elles-memes — et
 * rend les identites de ceux qui en meurent, orbes poses a la position lue
 * AVANT la compaction.
 *
 * ⚠️ **Les morts passent par le `DEATHS` EXISTANT** : `Room.step` les fusionne
 * avec celles des projectiles, car `GameClient#drainPendingDeaths` suppose un
 * seul `DEATHS` par tick (un lot rejoue apres un autre effacerait la
 * correction du premier).
 *
 * ⚠️ **La Surchauffe est un SECOND balayage dans la MEME fonction** : un seul
 * `dead`, une seule compaction. Elle ne peut pas passer par la marque : sa
 * zone porte l'element du DECLENCHEUR, qui peut etre Foudre (`burnPerTick`
 * nul). Le taux vient donc de `ZoneField.burnAt`, qui lit le nibble de
 * reaction.
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
    // ⚠️ La borne `<= 0` d'`appliquerDegats` ne se teste pas d'ici : 0,1 n'est
    // pas representable en `Float32Array`, la reserve ne tombe jamais pile a
    // zero. Ce sont les degats ENTIERS qui la tiennent.
    appliquerDegats(horde, i, burn, zones, tick, dead);
  }
  // `aliveAt`, pas `slowsAt` : un degat, pas un deplacement.
  //
  // ⚠️ **Une passe par ENTITE, jamais par zone** : deux zones de Surchauffe
  // superposees doubleraient la perte par tick. `ZoneField.burnAt` prend deja
  // le MAXIMUM entre zones qui se recouvrent.
  for (let i = 0; i < horde.count; i++) {
    // ⚠️ **Un ennemi deja tue par le balayage de marque ne reprend pas de
    // degats** : `horde.kill` n'arrive qu'a la fin.
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
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(dead);
  return dead;
}

/**
 * Verglas (Givre + Poix) : *« les ennemis derapent ET se percutent »*. Le
 * derapage VOYAGE et vit dans `Horde#recomputeSteering` ; la collision est un
 * DEGAT, donc arbitree ici, serveur seul (seules les morts voyagent, par
 * `DEATHS`).
 *
 * ⚠️ **Aucun etat nouveau sur `Horde`.** La liste des glissants est LOCALE,
 * rederivee chaque tick comme `#slow`.
 *
 * ⚠️ **Une SEULE liste pour toutes les zones qui se recouvrent** :
 * `ZoneField.collisionDamageAt` a deja pris le MAXIMUM entre zones, un ennemi
 * ne se percute pas deux fois avec le meme voisin.
 *
 * La distance de collision est `SEPARATION_RADIUS`, la distance de confort
 * que le steering maintient : plus proches, c'est le derapage qui les y a
 * laisses.
 *
 * Cout : O(zones x entites) pour reperer les glissants, puis O(k²) sur les k
 * glissants. k reste petit : au reglage actuel, la mort par collision vide la
 * zone avant qu'elle ne deborde ; a degat quasi nul, c'est le tassement a
 * `SEPARATION_RADIUS` qui le borne. Dans les deux cas, tres loin du k qui
 * menacerait le budget de tick (`bench/elements.bench.ts`, scenario Verglas).
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
      // ⚠️ **Verifie a CHAQUE paire** : `i` peut mourir d'une paire
      // precedente de cette boucle, et serait liste deux fois dans `dead`.
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
      orbs.spawn(
        id,
        horde.x[slot] ?? 0,
        horde.y[slot] ?? 0,
        horde.markAt(slot, tick),
        horde.markBy[slot] ?? 0,
      );
    }
  }
  horde.kill(dead);
  return dead;
}
