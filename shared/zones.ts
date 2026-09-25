import { ZONE_CAPACITY, ZONE_RADIUS, ZONE_REFRESH_INTERVAL_TICKS } from './constants';
import { elementOf } from './elements';
import { zoneElement } from './protocol';
import { zoneLifetimeTicks } from './reactions';

/**
 * Les zones au sol (§5 de la spec de l'etape 5a) : un disque teinte, **pose par
 * une REACTION** a son point d'application, qui vit `ZONE_LIFETIME_TICKS` puis
 * disparait.
 *
 * ⚠️ **« La ou un projectile elementaire finit sa course » jusqu'a la tache
 * 21.** L'auteur a joue et a bascule du modele du §6.3 de l'orientation — *«
 * les elements s'appliquent au sol autant qu'aux ennemis »* — vers celui du
 * §6.4, ou trois reactions sur quinze laissent deja un effet au sol. La boucle
 * devient : un projectile marque, un second element declenche, la reaction
 * laisse un champ. Le seul createur de zones est desormais `postZone`
 * (back/src/combat.ts), appele par `applyReactions`.
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
  /**
   * Ce que la zone porte : l'octet empaquete par `packZoneKind`
   * (`shared/protocol.ts`), pas un simple index dans `ELEMENTS` depuis la
   * tache 5 de l'etape 5b.
   *
   * ⚠️ **Toujours decoder avec `zoneElement` / `zoneReaction` avant de s'en
   * servir.** Depuis la tache 6 de l'etape 5b, `postZone` (back/src/combat.ts)
   * pose reellement un nibble de reaction non nul pour Surchauffe,
   * Embrasement et Court-circuit : un lecteur qui traiterait `kind` comme un
   * simple element perdrait ce nibble en silence — c'est exactement ce que
   * `Room#announceZones` et `Session#broadcast` faisaient encore a la tache 5,
   * et que leurs tests dediees gardent desormais. `element` et `elementOf`
   * different d'une lettre et pas d'un sens : ne pas confondre ce tableau
   * avec l'element qu'il faut en extraire.
   */
  readonly kind: Uint8Array;
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
   * ⚠️ **La tache 21 a supprime ce levier a la racine — et la regle RESTE.**
   * Une zone ne naissant plus que d'une reaction, et les reactions etant
   * bornees a une par ennemi et par tick (§6.2), la cadence ne peut plus
   * multiplier les poses : le banc `zones` compte 3 a 5 zones vivantes la ou il
   * en comptait 27 a 28. La fusion ne coute rien, elle borne toujours le compte
   * par la surface, et elle sera deja la le jour ou une reaction en chaine
   * arrivera (§6.4). **Une borne qui cesse d'etre sous tension n'est pas une
   * borne a retirer.**
   *
   * Une zone du meme `kind` (element ET type de reaction) qui couvre deja le
   * point est donc prolongee — au plus une fois par
   * `ZONE_REFRESH_INTERVAL_TICKS`, voir plus bas — et rien n'est cree. **Le
   * compte devient fonction de la SURFACE couverte**, pas de la cadence ni du
   * nombre d'exemplaires : deux zones du meme `kind` finissent toujours a plus
   * de `ZONE_RADIUS` l'une de l'autre. Un joueur qui arrose le meme endroit du
   * meme couple d'elements entretient une zone ; un joueur qui balaie la carte,
   * ou qui declenche un AUTRE couple au meme endroit, en pose plusieurs.
   *
   * ⚠️ **La fusion compare le `kind` COMPLET, PAS le seul element — corrige a
   * la revue de la tache 6, apres une mesure qui a pris le defaut en
   * flagrant delit.** La version precedente ne comparait que `zoneElement` :
   * deux zones de MEME element mais de `kind` different (une Surchauffe et un
   * Choc thermique generique, tous deux BRAISE) se confondaient l'une dans
   * l'autre — et LAQUELLE des deux gagnait dependait de l'ORDRE d'arrivee :
   *
   * | Ordre | `count` | `kind` retenu | consequence |
   * | --- | --- | --- | --- |
   * | generique BRAISE, puis Surchauffe a 10 px | 1 | `1` (BRAISE, reaction nulle) | Surchauffe ne brule jamais |
   * | Surchauffe, puis generique BRAISE a 10 px | 1 | `9` (BRAISE, Surchauffe) | un Choc thermique ordinaire brule 4,5 s pour des joueurs qui n'ont jamais fait Braise+Foudre |
   *
   * Deux memes objets, deux ordres, deux resultats opposes — et le cas est
   * ATTEIGNABLE aujourd'hui : Braise + Givre avec la Braise en second produit
   * deja un champ d'element Braise, indistinguable d'un Surchauffe pour un
   * predicat qui ne regarde que l'element. **Deux zones de `kind` different
   * sont deux objets differents et ne fusionnent pas** — c'est la seule regle
   * independante de l'ordre par construction. La fusion existe pour empecher
   * un joueur de peindre la carte avec LA MEME zone, pas pour confondre deux
   * effets distincts qui partagent un element.
   *
   * ⚠️ **Une zone de Braise et une zone de Givre au meme endroit coexistent**
   * (deux `kind` differents par construction, puisque l'element differe) —
   * c'est precisement leur recouvrement qui declenche la reaction du §5.2, et
   * les fusionner supprimerait la seconde voie du §6.3 de l'orientation. Ca
   * reste vrai apres la correction : comparer le `kind` complet ne fait que
   * SEPARER en plus les zones de meme element mais de `kind` different, jamais
   * fusionner celles d'elements differents.
   *
   * ⚠️ **Consequence mesuree sur `ZONE_CAPACITY` (128) : voir le rapport de la
   * tache 6, §« la fusion perdait le nibble ».** Plus de zones vivantes
   * simultanement des que plusieurs couples partagent un element — la tache 10
   * doit reprendre le banc `zones` avec un decor qui declenche reellement
   * plusieurs `kind` d'un meme element (aujourd'hui bloque par l'absence
   * d'armes de Foudre et de Poix, tache 9).
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
   *
   * ⚠️ **`kind` est l'octet COMPLET a stocker, pas le seul element.** Un
   * appelant qui ne connait encore aucun type de reaction (la seule situation
   * de la tache 5) passe l'element brut : `packZoneKind(element, 0) ===
   * element` pour tout element sur 3 bits, donc un `number` simple reste un
   * `kind` valide, de reaction nulle.
   */
  spawn(kind: number, x: number, y: number, playerId: number, tick: number): number {
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    for (let i = 0; i < this.#count; i++) {
      // ⚠️ **Le `kind` COMPLET, pas `zoneElement(kind)` seul.** Voir le
      // docbloc ci-dessus : comparer par element confondait deux effets
      // distincts qui partagent un element, et le resultat dependait de
      // l'ordre d'arrivee — un bug de fusion, pas une simplification.
      if ((this.kind[i] ?? 0) !== kind) {
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
   * que tout le monde passe par ce predicat. `expire` n'est donc plus une
   * regle de jeu, seulement une reprise de memoire.
   *
   * Meme borne que `expire` : une zone posee au tick `T` vaut encore au tick
   * `T + ZONE_LIFETIME_TICKS - 1` et plus au tick `T + ZONE_LIFETIME_TICKS`.
   *
   * ⚠️ **La duree n'est plus TOUJOURS `ZONE_LIFETIME_TICKS` depuis la tache 6
   * de l'etape 5b.** `zoneLifetimeTicks` (`shared/reactions.ts`) la derive du
   * `kind` empaquete : la generique pour la plupart des zones, une duree
   * propre pour celles qu'une reaction specifique allonge (Surchauffe). Les
   * deux cotes du fil decodent le meme octet et obtiennent la meme reponse,
   * sans rien annoncer de plus.
   */
  aliveAt(slot: number, tick: number): boolean {
    const born = this.bornTick[slot] ?? 0;
    return born <= tick && tick - born < zoneLifetimeTicks(this.kind[slot] ?? 0);
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
   * Le facteur d'amplification des degats au point `(x, y)` au tick `tick` :
   * le plus fort `Element.damageAmp` parmi les zones VIVANTES qui couvrent ce
   * point, et `1` s'il n'y en a aucune.
   *
   * ⚠️ **Un MAXIMUM, jamais une somme ni un produit.** Deux flaques qui se
   * recouvrent ne doublent pas : elles donnent la plus forte.
   *
   * ⚠️ **Et la raison n'est PAS celle du minimum de `Horde#computeSlow` — ne
   * pas confondre les deux.** Le ralentissement se combine par un minimum
   * parce qu'il VOYAGE : le client rejoue le deplacement, l'ordre d'iteration
   * des zones n'est pas garanti identique des deux cotes (`#removeAt` compacte
   * en echangeant avec la derniere, et le client garde ses zones mortes plus
   * longtemps), et seule une operation exactement commutative et associative
   * survit a ca. L'amplification, elle, ne voyage pas d'un octet : le client ne
   * prononce aucun degat, il apprend les morts par `DEATHS`. Le maximum est ici
   * une **decision de jeu** — une amplification qui se sommerait ferait de
   * l'empilement de Poix la seule strategie du jeu.
   *
   * ⚠️ **`aliveAt`, pas `slowsAt`.** C'est la meme question que se pose
   * `markInZones` — « cette zone existe-t-elle au tick T ? » — et pas celle du
   * deplacement, qui exige la borne stricte parce que la horde avance AVANT que
   * les zones du tick ne soient posees. Les degats, eux, se resolvent APRES les
   * poses : une zone nee ce tick amplifie deja.
   *
   * ⚠️ **Un point, pas un creneau d'entite.** `ZoneField` ne connait pas la
   * horde et ne doit pas l'apprendre : `overlaps` prend deja des indices de
   * zone, `ampAt` prend des coordonnees. C'est l'appelant qui sait de quelle
   * entite il parle.
   */
  ampAt(x: number, y: number, tick: number): number {
    const r2 = ZONE_RADIUS * ZONE_RADIUS;
    let amp = 1;
    for (let z = 0; z < this.#count; z++) {
      if (!this.aliveAt(z, tick)) {
        continue;
      }
      const dx = (this.x[z] ?? 0) - x;
      const dy = (this.y[z] ?? 0) - y;
      if (dx * dx + dy * dy >= r2) {
        continue;
      }
      const factor = elementOf(zoneElement(this.kind[z] ?? 0)).damageAmp;
      if (factor > amp) {
        amp = factor;
      }
    }
    return amp;
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
      if (tick - (this.bornTick[i] ?? 0) >= zoneLifetimeTicks(this.kind[i] ?? 0)) {
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
      this.kind[slot] = this.kind[last] ?? 0;
      this.x[slot] = this.x[last] ?? 0;
      this.y[slot] = this.y[last] ?? 0;
      this.by[slot] = this.by[last] ?? 0;
      this.bornTick[slot] = this.bornTick[last] ?? 0;
    }
    this.#count = last;
  }
}
