import {
  VIF_ARGENT_HIT_RADIUS_BONUS,
  ZONE_CAPACITY,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from './constants';
import {
  zoneArmorReductionTotal,
  zoneBurnPerTick,
  zoneCollisionDamage,
  zoneDamageAmpTotal,
  zoneLifetimeTicks,
  zoneRadius,
  zoneVifArgent,
} from './reactions';

/**
 * Les zones au sol : un disque teinte, **pose par une REACTION** a son point
 * d'application, qui vit `ZONE_LIFETIME_TICKS` puis disparait. Le seul
 * createur de zones est `postZone` (back/src/combat.ts), appele par
 * `applyReactions`.
 *
 * ⚠️ **Vit dans `shared/` et pas dans `back/`, contrairement a `OrbField`.**
 * La zone est annoncee A LA CREATION (le client ne peut pas savoir ou finit
 * un projectile serveur), mais sa MORT est DERIVEE des deux cotes a partir du
 * seul `bornTick`. Le client dessine les zones : il doit les faire mourir avec
 * exactement le meme code que le serveur.
 *
 * Pour le reste, c'est `OrbField` trait pour trait : capacite fixe, tableaux
 * types, retrait par indice decroissant, expiration derivee du `bornTick`.
 */
/**
 * Le rayon AU CARRE de chaque `kind` de zone possible, cuit au chargement.
 *
 * ⚠️ **Une table, pas un appel dans la boucle**, comme `HIT_R2_BY_ARCHETYPE`
 * (`shared/projectiles.ts`). Les balayages de cette classe sont appeles PAR
 * ENTITE et par tick : `zoneRadius(kind)` y ferait une recherche dans
 * `REACTION_DEFS` dans une boucle en entites x zones. `kind` tient sur un
 * octet, donc 256 entrees couvrent tout.
 */
const ZONE_R2_BY_KIND = Float32Array.from({ length: 256 }, (_, kind) => {
  const r = zoneRadius(kind);
  return r * r;
});

/** Le rayon au carre de la zone du creneau `slot` — voir `ZONE_R2_BY_KIND`. */
function r2Of(kind: number): number {
  return ZONE_R2_BY_KIND[kind] ?? ZONE_RADIUS * ZONE_RADIUS;
}

export class ZoneField {
  /**
   * Ce que la zone porte : l'octet empaquete par `packZoneKind`
   * (`shared/protocol.ts`), pas un simple index dans `ELEMENTS`.
   *
   * ⚠️ **Toujours decoder avec `zoneElement` / `zoneReaction` avant de s'en
   * servir.** `postZone` pose un nibble de reaction non nul (Surchauffe,
   * Embrasement, Court-circuit…) : un lecteur qui traiterait `kind` comme un
   * simple element le perdrait en silence.
   */
  readonly kind: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Index du joueur qui a pose la zone — c'est lui que la Synergie consomme. */
  readonly by: Uint8Array;
  /** Tick de la pose, ou de la derniere refection par fusion. Voir `spawn` et `expire`. */
  readonly bornTick: Uint32Array;
  #count = 0;

  /**
   * Plafond dur, `ZONE_CAPACITY` — pas un parametre de construction,
   * contrairement a `OrbField` : les deux cotes du fil dimensionnent leur
   * reserve sur la meme constante, et deux copies divergeraient.
   */
  readonly capacity = ZONE_CAPACITY;

  /**
   * Zones qu'une pose n'a pas pu creer faute de place, cumulees depuis la
   * creation. Jamais remis a zero ici : c'est l'appelant qui draine ses
   * metriques, comme `Projectiles.truncatedProjectiles`.
   *
   * ⚠️ **Une zone qui ne se pose pas est un effet que le joueur a paye et qui
   * ne se voit pas** : ca ne doit jamais disparaitre sans trace.
   */
  truncatedZones = 0;

  constructor() {
    this.kind = new Uint8Array(this.capacity);
    this.x = new Float32Array(this.capacity);
    this.y = new Float32Array(this.capacity);
    this.by = new Uint8Array(this.capacity);
    this.bornTick = new Uint32Array(this.capacity);
  }

  get count(): number {
    return this.#count;
  }

  /**
   * Pose une zone — ou rafraichit celle qui couvre deja le point.
   *
   * ⚠️ **C'est la regle de pose qui borne le cout, pas le plafond.** Une zone
   * du meme `kind` qui couvre deja le point est prolongee — au plus une fois
   * par `ZONE_REFRESH_INTERVAL_TICKS` — et rien n'est cree : **le compte
   * devient fonction de la SURFACE couverte**, pas de la cadence. Les
   * reactions bornent deja les poses, mais une borne qui cesse d'etre sous
   * tension n'est pas une borne a retirer (une reaction en chaine la
   * remettrait sous tension).
   *
   * ⚠️ **La fusion compare le `kind` COMPLET (element ET reaction), PAS le
   * seul element.** Par element, deux zones distinctes de meme element (une
   * Surchauffe et un Choc thermique generique, toutes deux Braise) se
   * confondraient, et laquelle gagne dependrait de l'ORDRE d'arrivee. Deux
   * zones de `kind` different coexistent : c'est d'ailleurs le recouvrement
   * d'une Braise et d'un Givre qui declenche une reaction.
   *
   * ⚠️ **La fusion n'est pas `overlaps`.** Elle teste si le POINT tombe dans
   * une zone existante, pas si deux disques se touchent : fusionner sur
   * `overlaps` laisserait des trous dans une trainee de tir.
   *
   * ⚠️ **Appeler `expire(tick)` avant, une fois par tick** : c'est lui qui
   * borne la memoire. Le balayage saute de toute facon les zones que
   * `aliveAt` juge perimees, car le CLIENT garde des zones mortes pour
   * rejouer (voir `aliveAt`) et applique le meme `spawn`.
   *
   * Rend le creneau touche — cree ou rafraichi — ou `-1` si la reserve est
   * pleine. Le message `ZONE` porte le centre STOCKE, jamais celui du
   * projectile, pour qu'un client qui rejoue la meme pose retombe sur la
   * meme zone.
   *
   * `kind` est l'octet COMPLET a stocker. `packZoneKind(element, 0) ===
   * element` : un element brut reste un `kind` valide, de reaction nulle.
   */
  spawn(kind: number, x: number, y: number, playerId: number, tick: number): number {
    // Le rayon de la zone qu'on POSE : la fusion ne compare que des zones de
    // meme `kind`, donc de meme rayon.
    const r2 = r2Of(kind);
    for (let i = 0; i < this.#count; i++) {
      // ⚠️ Le `kind` COMPLET, pas `zoneElement(kind)` seul (voir ci-dessus).
      if ((this.kind[i] ?? 0) !== kind) {
        continue;
      }
      if (!this.aliveAt(i, tick)) {
        continue;
      }
      const dx = (this.x[i] ?? 0) - x;
      const dy = (this.y[i] ?? 0) - y;
      if (dx * dx + dy * dy < r2) {
        // ⚠️ **AU PLUS une prolongation par `ZONE_REFRESH_INTERVAL_TICKS`.**
        // Prolonger oblige a annoncer (sinon la zone du client meurt avant
        // celle du serveur), et annoncer chaque fusion ferait suivre au
        // trafic la cadence des armes. **L'annonce EST la verite** : le
        // client applique ce meme `spawn` sur le meme etat, donc il n'y a
        // jamais deux dates de peremption pour une seule zone.
        if (tick - (this.bornTick[i] ?? 0) >= ZONE_REFRESH_INTERVAL_TICKS) {
          this.bornTick[i] = tick;
        }
        return i;
      }
    }

    if (this.#count >= this.capacity) {
      this.truncatedZones++;
      return -1;
    }

    const slot = this.#count++;
    this.kind[slot] = kind;
    this.x[slot] = x;
    this.y[slot] = y;
    this.by[slot] = playerId;
    this.bornTick[slot] = tick;
    return slot;
  }

  /**
   * La zone `slot` est-elle POSEE et pas encore perimee au tick `tick` ?
   *
   * ⚠️ **C'est ce predicat, jamais la simple presence dans le tableau, qui
   * dit si une zone existe.** Le serveur appelle `expire(tick)` a l'heure, si
   * bien que chez lui les deux coincident ; le CLIENT, lui, garde ses zones
   * mortes `ROLLBACK_DEPTH_TICKS` ticks de plus, parce que `HordeHistory` ne
   * sauvegarde QUE la horde : un rejeu qui repart d'un tick ou la zone vivait
   * encore doit pouvoir la retrouver. Une zone retiree du tableau est
   * irrecuperable ; une zone morte laissee dans le tableau est inerte, tant
   * que tout le monde passe par ce predicat. `expire` n'est qu'une reprise de
   * memoire.
   *
   * Une zone posee au tick `T` vaut encore au tick `T + duree - 1` et plus au
   * tick `T + duree`. La duree vient de `zoneLifetimeTicks`
   * (`shared/reactions.ts`), derivee du `kind` : certaines reactions
   * (Surchauffe) l'allongent, sans rien annoncer de plus.
   */
  aliveAt(slot: number, tick: number): boolean {
    const born = this.bornTick[slot] ?? 0;
    return born <= tick && tick - born < zoneLifetimeTicks(this.kind[slot] ?? 0);
  }

  /**
   * La zone `slot` RALENTIT-elle la horde au tick `tick` ?
   *
   * ⚠️ **Deux predicats distincts, et il ne faut pas les confondre** :
   *
   * | Question | Borne basse |
   * | --- | --- |
   * | La zone existe-t-elle au tick T ? (`aliveAt`) | `bornTick <= T` |
   * | La zone ralentit-elle au tick T ? (`slowsAt`) | `bornTick < T` |
   *
   * La difference tient a l'ORDRE du tick serveur : `Room.step` fait avancer
   * la horde AVANT de resoudre les projectiles, donc une zone posee au tick
   * `T` n'existe pas encore quand la horde bouge ce tick-la. Elle ne ralentit
   * qu'a partir de `T + 1`. Sans cette borne stricte, un client qui rejoue
   * depuis `bornTick` ralentirait un tick de plus que le serveur — un tick de
   * decalage sur le deplacement.
   */
  slowsAt(slot: number, tick: number): boolean {
    return (this.bornTick[slot] ?? 0) < tick && this.aliveAt(slot, tick);
  }

  /**
   * Le facteur d'amplification des degats au point `(x, y)` au tick `tick` :
   * le plus fort `Element.damageAmp` parmi les zones VIVANTES qui couvrent ce
   * point, et `1` s'il n'y en a aucune.
   *
   * ⚠️ **Un MAXIMUM, jamais une somme ni un produit.** Deux flaques qui se
   * recouvrent ne doublent pas : elles donnent la plus forte.
   *
   * ⚠️ **Et la raison n'est PAS celle du minimum de `Horde#computeSlow`.** Le
   * ralentissement se combine par un minimum parce qu'il VOYAGE : le client
   * rejoue le deplacement, l'ordre des zones n'est pas garanti identique des
   * deux cotes, et seule une operation exactement commutative et associative
   * y survit. L'amplification, elle, ne voyage pas : le client ne prononce
   * aucun degat. Le maximum est ici une **decision de jeu** — une somme ferait
   * de l'empilement de Poix la seule strategie du jeu.
   *
   * ⚠️ **`aliveAt`, pas `slowsAt`.** Les degats se resolvent APRES les poses
   * du tick : une zone nee ce tick amplifie deja. C'est le deplacement qui
   * exige la borne stricte, parce que la horde avance AVANT les poses.
   *
   * ⚠️ **Un point, pas un creneau d'entite** : `ZoneField` ne connait pas la
   * horde.
   *
   * ⚠️ **Lu par `zoneDamageAmpTotal`, jamais par
   * `elementOf(zoneElement(kind)).damageAmp`** : il combine l'element et la
   * reaction (Mortier vif), et l'element du nibble est celui du DECLENCHEUR,
   * qui depend de l'ordre d'arrivee.
   */
  ampAt(x: number, y: number, tick: number): number {
    let amp = 1;
    for (let z = 0; z < this.#count; z++) {
      if (!this.aliveAt(z, tick)) {
        continue;
      }
      const dx = (this.x[z] ?? 0) - x;
      const dy = (this.y[z] ?? 0) - y;
      // Le rayon de CETTE zone : toutes ne portent pas le meme.
      if (dx * dx + dy * dy >= r2Of(this.kind[z] ?? 0)) {
        continue;
      }
      const factor = zoneDamageAmpTotal(this.kind[z] ?? 0);
      if (factor > amp) {
        amp = factor;
      }
    }
    return amp;
  }

  /**
   * La reduction d'armure au point `(x, y)` au tick `tick` : la plus forte
   * `zoneArmorReductionTotal` parmi les zones VIVANTES qui couvrent ce point
   * (Supraconduction, Chaux), et `0` s'il n'y en a aucune.
   *
   * Meme forme qu'`ampAt` (meme balayage, `aliveAt`, MAXIMUM par decision de
   * jeu) : seul le serveur lit l'armure (`armureA`, `back/src/combat.ts`).
   * `zoneArmorReductionTotal` combine element et reaction, pour la meme
   * raison d'ordre d'arrivee.
   */
  armorReductionAt(x: number, y: number, tick: number): number {
    let reduction = 0;
    for (let z = 0; z < this.#count; z++) {
      if (!this.aliveAt(z, tick)) {
        continue;
      }
      const dx = (this.x[z] ?? 0) - x;
      const dy = (this.y[z] ?? 0) - y;
      // Le rayon de CETTE zone : toutes ne portent pas le meme.
      if (dx * dx + dy * dy >= r2Of(this.kind[z] ?? 0)) {
        continue;
      }
      const factor = zoneArmorReductionTotal(this.kind[z] ?? 0);
      if (factor > reduction) {
        reduction = factor;
      }
    }
    return reduction;
  }

  /**
   * Le degat de collision au point `(x, y)` au tick `tick` : le plus fort
   * `ReactionDef.zoneCollisionDamage` parmi les zones VIVANTES qui couvrent
   * ce point (Verglas : « les ennemis se percutent »), et `0` s'il n'y en a
   * aucune.
   *
   * Meme forme qu'`ampAt` : seul `resolveVerglasCollisions`
   * (`back/src/combat.ts`) le lit, et c'est lui qui apparie les points de la
   * horde.
   */
  collisionDamageAt(x: number, y: number, tick: number): number {
    let damage = 0;
    for (let z = 0; z < this.#count; z++) {
      if (!this.aliveAt(z, tick)) {
        continue;
      }
      const dx = (this.x[z] ?? 0) - x;
      const dy = (this.y[z] ?? 0) - y;
      // Le rayon de CETTE zone : toutes ne portent pas le meme.
      if (dx * dx + dy * dy >= r2Of(this.kind[z] ?? 0)) {
        continue;
      }
      const factor = zoneCollisionDamage(this.kind[z] ?? 0);
      if (factor > damage) {
        damage = factor;
      }
    }
    return damage;
  }

  /**
   * Le degat de brulure de zone au point `(x, y)` au tick `tick` : le plus
   * fort `ReactionDef.zoneBurnPerTick` parmi les zones VIVANTES qui couvrent
   * ce point (Surchauffe : « la zone brule d'elle-meme »), et `0` s'il n'y en
   * a aucune.
   *
   * ⚠️ **Un MAXIMUM, et `resolveBurn` l'appelle UNE fois par entite**, jamais
   * une fois par zone : sinon deux Surchauffes superposees doubleraient la
   * perte par tick, et l'empilement deviendrait la strategie dominante. Meme
   * forme qu'`ampAt`, `aliveAt` compris.
   *
   * ⚠️ **DERIVEE de `ReactionDef.zoneBurnPerTick`, jamais de
   * `elementOf(zoneElement(kind)).burnPerTick`** : une Surchauffe porte
   * l'element du DECLENCHEUR, et si c'est Foudre, la lecture generique ne
   * brulerait jamais.
   */
  burnAt(x: number, y: number, tick: number): number {
    let burn = 0;
    for (let z = 0; z < this.#count; z++) {
      if (!this.aliveAt(z, tick)) {
        continue;
      }
      const dx = (this.x[z] ?? 0) - x;
      const dy = (this.y[z] ?? 0) - y;
      // Le rayon de CETTE zone : toutes ne portent pas le meme.
      if (dx * dx + dy * dy >= r2Of(this.kind[z] ?? 0)) {
        continue;
      }
      const factor = zoneBurnPerTick(this.kind[z] ?? 0);
      if (factor > burn) {
        burn = factor;
      }
    }
    return burn;
  }

  /**
   * La majoration du rayon de touche au point `(x, y)` au tick `tick` :
   * `VIF_ARGENT_HIT_RADIUS_BONUS` si une zone VIVANTE de Vif-argent couvre ce
   * point (« attire les projectiles », rendu comme un rayon elargi), et `0`
   * s'il n'y en a aucune.
   *
   * ⚠️ **PAS un champ porte par `Element`** : comme la Foudre, l'effet du
   * Vif-argent vit hors de la table des elements (`EFFET_HORS_TABLE` dans
   * `shared/elements.test.ts`).
   *
   * Meme forme qu'`ampAt` : `aliveAt`, MAXIMUM par decision de jeu.
   *
   * ⚠️ **Branchee cote SERVEUR SEUL** (`Projectiles.collide`), au site ou la
   * collision se resout — jamais dans `#emit`/`fireSalvoDirected`.
   *
   * ⚠️ **Le critere est `zoneVifArgent` (`shared/reactions.ts`), le MEME champ
   * que `linkedNeighbours`** : un seul critere pour les deux effets du
   * Vif-argent. Voir le docbloc de `linkedNeighbours` (`shared/links.ts`).
   */
  hitRadiusBonusAt(x: number, y: number, tick: number): number {
    let bonus = 0;
    for (let z = 0; z < this.#count; z++) {
      if (!this.aliveAt(z, tick)) {
        continue;
      }
      const dx = (this.x[z] ?? 0) - x;
      const dy = (this.y[z] ?? 0) - y;
      // Le rayon de CETTE zone : toutes ne portent pas le meme.
      if (dx * dx + dy * dy >= r2Of(this.kind[z] ?? 0)) {
        continue;
      }
      if (!zoneVifArgent(this.kind[z] ?? 0)) {
        continue;
      }
      if (VIF_ARGENT_HIT_RADIUS_BONUS > bonus) {
        bonus = VIF_ARGENT_HIT_RADIUS_BONUS;
      }
    }
    return bonus;
  }

  /**
   * Retire les zones dont la duree de vie a expire — expiration DERIVEE,
   * aucun message : les deux cotes calculent la meme date de
   * peremption a partir du meme `bornTick`, connu depuis le message qui a
   * annonce la zone.
   *
   * Retrait par indice decroissant, meme raisonnement que `OrbField.expire`,
   * `Horde.kill` et `Projectiles.#removeAt` : une zone deplacee dans un trou
   * par une compaction ne doit jamais etre elle-meme sautee par erreur
   * ensuite.
   */
  expire(tick: number): void {
    for (let i = this.#count - 1; i >= 0; i--) {
      if (tick - (this.bornTick[i] ?? 0) >= zoneLifetimeTicks(this.kind[i] ?? 0)) {
        this.#removeAt(i);
      }
    }
  }

  /**
   * Deux zones se recouvrent si la distance de leurs centres est INFERIEURE a
   * la somme de leurs rayons — tangentes, elles ne se recouvrent pas.
   *
   * Prend des indices de creneau plutot que des objets : le balayage est en
   * O(zones²), et allouer une paire d'objets par couple le rendrait
   * couteux la ou il l'est deja le plus.
   *
   * Compare les carres, jamais `Math.hypot`, comme tout le depot.
   */
  overlaps(a: number, b: number): boolean {
    // La SOMME des deux rayons, qui peuvent differer selon le `kind`.
    const sum = Math.sqrt(r2Of(this.kind[a] ?? 0)) + Math.sqrt(r2Of(this.kind[b] ?? 0));
    const dx = (this.x[a] ?? 0) - (this.x[b] ?? 0);
    const dy = (this.y[a] ?? 0) - (this.y[b] ?? 0);
    return dx * dx + dy * dy < sum * sum;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.kind[slot] = this.kind[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.by[slot] = this.by[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
    }
    this.#count = last;
  }
}
