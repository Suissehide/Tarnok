import {
  ZONE_CAPACITY,
  ZONE_LIFETIME_TICKS,
  ZONE_RADIUS,
  ZONE_REFRESH_INTERVAL_TICKS,
} from './constants';

/**
 * Les zones au sol (§5 de la spec de l'etape 5a) : un disque teinte, pose la
 * ou un projectile elementaire finit sa course, qui vit `ZONE_LIFETIME_TICKS`
 * puis disparait.
 *
 * ⚠️ **Vit dans `shared/` et pas dans `back/`, contrairement a `OrbField`.**
 * La zone est annoncee A LA CREATION (§5.3 : le client ne peut pas savoir ou
 * finit un projectile serveur — les siens sont cosmetiques depuis l'etape 3,
 * tires depuis une position predite puis reconciliee), mais sa MORT est
 * DERIVEE des deux cotes a partir du seul `bornTick`. Le client dessine les
 * zones : il doit donc les faire mourir avec exactement le meme code que le
 * serveur. Une expiration calculee differemment ferait disparaitre un quad
 * plus tot chez l'un — visible, et le debut d'une divergence.
 *
 * Pour le reste, c'est `OrbField` de `back/src/combat.ts` trait pour trait :
 * capacite fixe, tableaux types (jamais un objet par zone, meme raisonnement
 * que `Horde` et `Projectiles`), retrait par indice decroissant, expiration
 * derivee du `bornTick` sans un octet sur le fil.
 */
export class ZoneField {
  /** Element de la zone, index dans `ELEMENTS`. */
  readonly element: Uint8Array;
  readonly x: Float32Array;
  readonly y: Float32Array;
  /** Index du joueur qui a pose la zone — c'est lui que la Synergie du §7 consomme. */
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
   * ne se voit pas.** Ca ne doit jamais disparaitre sans trace — meme motif
   * que `truncatedProjectiles` pour les salves et `RoomMetrics.truncatedSpawns`
   * pour les vagues.
   */
  truncatedZones = 0;

  constructor() {
    this.element = new Uint8Array(this.capacity);
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
   * ⚠️ **C'est la regle de pose qui borne le cout, pas le plafond** (§5.1 bis
   * de la spec). Avec « un projectile = une zone », la cadence d'une arme
   * elementaire devenait le principal levier de cout du jeu, et l'empilement
   * de l'etape 4 la faisait exploser — chaque exemplaire ajoutant un
   * projectile a la salve :
   *
   * | Armes elementaires retenues | Zones vivantes a quatre joueurs |
   * | --- | --- |
   * | 1 exemplaire chacune | 90 |
   * | 4 exemplaires | 209 |
   * | 8 exemplaires | 368 |
   *
   * Contre « quelques dizaines » budgetees au §6.6 de l'orientation, et un
   * recouvrement en O(zones²). Choisir des armes lentes n'etait pas une
   * parade : c'est un reglage qui tient jusqu'au premier draft.
   *
   * Une zone du meme element qui couvre deja le point est donc prolongee — au
   * plus une fois par `ZONE_REFRESH_INTERVAL_TICKS`, voir plus bas — et rien
   * n'est cree. **Le compte devient fonction de
   * la SURFACE couverte**, pas de la cadence ni du nombre d'exemplaires : deux
   * zones du meme element finissent toujours a plus de `ZONE_RADIUS` l'une de
   * l'autre. Un joueur qui arrose le meme endroit entretient une zone ; un
   * joueur qui balaie la carte en pose plusieurs.
   *
   * ⚠️ **La fusion est PAR ELEMENT.** Une zone de Braise et une zone de Givre
   * au meme endroit coexistent — c'est precisement leur recouvrement qui
   * declenche la reaction du §5.2, et les fusionner supprimerait la seconde
   * voie du §6.3 de l'orientation.
   *
   * ⚠️ **La fusion n'est pas `overlaps`.** Elle teste si le POINT tombe dans
   * une zone existante (distance < `ZONE_RADIUS`), pas si deux disques se
   * touchent (distance < 2 × `ZONE_RADIUS`). Fusionner sur `overlaps`
   * espacerait les zones d'un diametre entier et laisserait des trous dans une
   * trainee de tir.
   *
   * ⚠️ **Appeler `expire(tick)` avant, une fois par tick.** Ce balayage ne
   * connait que les zones vivantes ; une zone perimee mais pas encore retiree
   * serait rafraichie au lieu d'etre remplacee — meme contrat d'ordre que
   * `OrbField.resolvePickups`, qui expire avant de resoudre.
   *
   * Depuis la tache 6, le balayage se protege LUI-MEME contre ce cas en
   * sautant les zones que `aliveAt` juge perimees : le contrat d'ordre reste
   * exige (c'est lui qui borne la memoire), mais le CLIENT, lui, garde
   * volontairement des zones mortes quelques ticks de plus pour pouvoir
   * rejouer (voir `aliveAt`), et il applique le meme `spawn`.
   *
   * Rend le creneau touche — celui qui vient d'etre cree ou celui qui vient
   * d'etre rafraichi — ou `-1` si la reserve etait pleine. C'est ce que
   * `Room` annonce : le message `ZONE` porte le centre STOCKE, jamais celui
   * du projectile, pour qu'un client qui rejoue la meme pose retombe sur la
   * meme zone (distance nulle) sans avoir a deviner laquelle fusionner.
   */
  spawn(element: number, x: number, y: number, playerId: number, tick: number): number {
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    for (let i = 0; i < this.#count; i++) {
      if (this.element[i] !== element) {
        continue;
      }
      if (!this.aliveAt(i, tick)) {
        continue;
      }
      const dx = (this.x[i] ?? 0) - x;
      const dy = (this.y[i] ?? 0) - y;
      if (dx * dx + dy * dy < r2) {
        // ⚠️ **AU PLUS une prolongation par `ZONE_REFRESH_INTERVAL_TICKS`, et
        // le silence est aussi une decision** (§5.1 bis, tache 10). Prolonger
        // ici oblige a annoncer — sinon la zone du client meurt avant celle du
        // serveur — et annoncer chaque fusion fait suivre au trafic la cadence
        // des armes : 9,67 ko/s par client a 30 zones arrosees sans relache
        // (banc `zones`), contre 1,22 ko/s de trafic TOTAL a l'etape 4.
        //
        // Alors on ne prolonge pas. **L'annonce EST la verite** : le
        // `bornTick` qui fait foi est celui de la derniere annonce, des DEUX
        // cotes — le client applique ce meme `spawn` sur le meme etat, donc il
        // repond la meme chose au meme tick, et il n'y a jamais deux dates de
        // peremption pour une seule zone.
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
    this.element[slot] = element;
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
   * que tout le monde passe par ce predicat. `expire` n'est donc plus une
   * regle de jeu, seulement une reprise de memoire.
   *
   * Meme borne que `expire` : une zone posee au tick `T` vaut encore au tick
   * `T + ZONE_LIFETIME_TICKS - 1` et plus au tick `T + ZONE_LIFETIME_TICKS`.
   */
  aliveAt(slot: number, tick: number): boolean {
    const born = this.bornTick[slot] ?? 0;
    return born <= tick && tick - born < ZONE_LIFETIME_TICKS;
  }

  /**
   * La zone `slot` RALENTIT-elle la horde au tick `tick` ?
   *
   * ⚠️ **Deux predicats distincts, et il ne faut pas les confondre** — meme
   * piege que la fusion et le recouvrement (§5.1 bis de la spec), qui ont
   * deja coute un facteur 2 a la tache 4 :
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
   * decalage sur le deplacement, exactement ce que le rejeu existe pour
   * eviter.
   */
  slowsAt(slot: number, tick: number): boolean {
    return (this.bornTick[slot] ?? 0) < tick && this.aliveAt(slot, tick);
  }

  /**
   * Retire les zones dont la duree de vie a expire — expiration DERIVEE
   * (§5.3), aucun message : les deux cotes calculent la meme date de
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
      if (tick - (this.bornTick[i] ?? 0) >= ZONE_LIFETIME_TICKS) {
        this.#removeAt(i);
      }
    }
  }

  /**
   * Deux zones se recouvrent si la distance de leurs centres est INFERIEURE a
   * la somme de leurs rayons — tangentes, elles ne se recouvrent pas.
   *
   * Prend des indices de creneau plutot que des objets : le balayage du §5.2
   * est en O(zones²), et allouer une paire d'objets par couple le rendrait
   * couteux la ou il l'est deja le plus.
   *
   * ⚠️ **Compare les carres, jamais `Math.hypot`** : c'est la convention de
   * tout le depot (`resolvePickups`, `resolveContact`, `collide`) — une racine
   * carree par couple, sur un balayage quadratique, pour une comparaison qui
   * n'en a pas besoin.
   */
  overlaps(a: number, b: number): boolean {
    // Toutes les zones portent le meme rayon aujourd'hui ; ecrit comme une
    // somme parce que c'est ca, la regle, et qu'un rayon par zone ne serait
    // alors qu'un changement local.
    const sum = ZONE_RADIUS + ZONE_RADIUS;
    const dx = (this.x[a] ?? 0) - (this.x[b] ?? 0);
    const dy = (this.y[a] ?? 0) - (this.y[b] ?? 0);
    return dx * dx + dy * dy < sum * sum;
  }

  #removeAt(slot: number): void {
    const last = this.#count - 1;
    if (slot !== last) {
      this.element[slot] = this.element[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.by[slot] = this.by[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
    }
    this.#count = last;
  }
}
