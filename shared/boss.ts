import { BOSS_BODY_SCALE } from './archetypes';
import { PLAYER_MAX_HP, PROJECTILE_HIT_RADIUS, TICK_HZ } from './constants';
import { CHARGE_DIR_SCALE } from './protocol';

/**
 * La charge du troll (etape 6a, tache 5 bis).
 *
 * > *« Le troll charge une attaque lineaire, donc un long rectangle, et son
 * > animation le fait tourner, donc il spin rapidement a travers ce rectangle
 * > en avancant. »*
 *
 * ⚠️ **CE N'EST PAS UN TELEGRAPHE, C'EST UN DEPLACEMENT.** Une zone qui se
 * remplit sur place ne touche rien ; ici, **le boss traverse le rectangle**,
 * donc sa position est pilotee par l'attaque et non par le champ de flux
 * pendant toute la charge. C'est le meme risque que le ralentissement du Givre
 * a l'etape 5a — un effet qui touche le DEPLACEMENT touche le contrat de
 * replication a 0,000 px.
 *
 * **La parade est celle qui a deja servi trois fois** (les zones, le gel de
 * niveau, le vol des orbes) : le serveur annonce **une fois** — origine,
 * direction, longueur, largeur, ticks de debut et de fin — et **les deux cotes
 * DERIVENT la position le long du couloir** a partir des ticks. Zero octet
 * apres l'annonce, meme position partout, par construction.
 *
 * ⚠️ **Tout ce qui est ici est PUR et sans etat.** Une `BossCharge` est une
 * valeur : elle ne bouge jamais apres son annonce, et les deux cotes n'en
 * lisent que des fonctions du tick. C'est ce qui la rend rejouable — le client
 * qui restaure sa horde a `windupTick` et rejoue jusqu'au present retombe
 * exactement sur les positions du serveur, sans avoir a sauvegarder quoi que
 * ce soit de la charge dans l'anneau (`HordeHistory`).
 *
 * ⚠️ **Les constantes de la charge vivent ICI et pas dans `constants.ts`**,
 * pour la meme raison que `BOSS_HP_MULTIPLE` et `BOSS_BODY_SCALE` vivent dans
 * `archetypes.ts` : la largeur du couloir se DERIVE du corps du boss, donc de
 * `BOSS_BODY_SCALE`, et `constants.ts` ne peut pas importer `archetypes.ts`
 * (c'est l'inverse qui est vrai).
 */

/**
 * Duree du chargement, en ticks (1 s a `TICK_HZ`) : le boss est immobile, le
 * couloir est annonce, **rien ne fait mal**.
 *
 * ⚠️ **C'EST LA FENETRE DE REACTION, et c'est ce qui rend le telegraphe sur.**
 * Trop court, l'attaque est une taxe ; trop long, elle est decorative. A
 * `PLAYER_SPEED` (260 px/s), une seconde donne 260 px de deplacement lateral
 * pour une demi-largeur de couloir de `BOSS_CHARGE_WIDTH_PX / 2` (96 px) : un
 * joueur qui voit le rectangle et bouge en sort largement, un joueur qui ne
 * regarde pas se fait prendre.
 *
 * **Reglage a l'oeil, tache 12.**
 */
export const BOSS_CHARGE_WINDUP_TICKS = TICK_HZ;

/**
 * Duree de la traversee, en ticks (0,6 s a `TICK_HZ`).
 *
 * Avec `BOSS_CHARGE_LENGTH_PX`, la vitesse de charge vaut 1 500 px/s, soit
 * 23 fois la vitesse de marche du troll (65 px/s) et presque six fois celle
 * d'un joueur : une fois partie, la charge ne se distance pas — **elle
 * s'esquive avant**, pendant le chargement. C'est la meme regle que le §4 de
 * la spec pose pour la direction (« figee au chargement ») : ce qui se joue,
 * se joue AVANT le depart.
 */
export const BOSS_CHARGE_TICKS = 18;

/**
 * Longueur du couloir, en pixels monde.
 *
 * 900 px : un peu plus d'un ecran de large a la camera actuelle, donc le
 * rectangle se lit en entier quand il apparait — un couloir plus long
 * annoncerait une menace dont on ne verrait pas la fin.
 */
export const BOSS_CHARGE_LENGTH_PX = 900;

/**
 * Largeur du couloir, en pixels monde — **la taille du corps qui le traverse**,
 * jamais un nombre choisi.
 *
 * `2 x PROJECTILE_HIT_RADIUS x BOSS_BODY_SCALE` = 192 px : exactement le
 * diametre de la hitbox du boss (`Archetype.bodyScale`). Le rectangle dessine
 * dit donc la verite sur ce qui va passer dedans — c'est la meme discipline que
 * `ZoneRenderer`, dont le disque garde exactement le rayon de la regle parce
 * que « la frontiere d'une zone est une regle de jeu ».
 *
 * ⚠️ Le SPRITE, lui, est dessine a `BODY_SCALE` (1,25) de plus par
 * `HordeRenderer` — le corps deborde donc un peu du couloir, exactement comme
 * il deborde deja de sa hitbox de tir pour toute la pietaille.
 */
export const BOSS_CHARGE_WIDTH_PX = 2 * PROJECTILE_HIT_RADIUS * BOSS_BODY_SCALE;

/**
 * Degats d'une charge sur un joueur, **une seule fois par charge**.
 *
 * `PLAYER_MAX_HP / 5` : cinq charges encaissees tuent un joueur qui n'esquive
 * jamais, une seule ne le condamne pas. Deux fois et demie le contact ordinaire
 * (`CONTACT_DAMAGE`), parce qu'une attaque annoncee une seconde a l'avance doit
 * couter plus cher que de frotter un monstre.
 *
 * ⚠️ **C'est un REGLAGE DE JEU, pas un invariant** — meme statut que
 * `REACTION_DAMAGE` : il se juge en jeu (tache 12), et **aucun test ne doit
 * ecrire 20 en dur**. Les assertions se derivent de cette constante ou la
 * comparent a `CONTACT_DAMAGE`.
 */
export const BOSS_CHARGE_DAMAGE = PLAYER_MAX_HP / 5;

/**
 * Ticks entre la fin d'une charge et le moment ou la suivante peut s'annoncer
 * (2 s a `TICK_HZ`).
 *
 * Avec le chargement et la traversee, une charge revient donc toutes les
 * ~3,6 s : assez pour que le boss marche entre deux — il doit rester une
 * creature qui avance vers vous, pas une machine a couloirs.
 */
export const BOSS_CHARGE_COOLDOWN_TICKS = 2 * TICK_HZ;

/**
 * Une charge annoncee. **Immuable** : c'est une valeur, pas un etat.
 *
 * Les trois ticks sont ABSOLUS (`Room.tick` / le compteur local aligne dessus),
 * jamais des durees relatives a la reception : c'est ce qui fait qu'un client
 * en retard de trois ticks retombe sur la meme position que le serveur, en
 * rejouant.
 */
export interface BossCharge {
  /** Identite de l'entite qui charge — c'est elle, et elle seule, que la charge deplace. */
  readonly entityId: number;
  /** Origine du couloir : la position du boss au moment de l'annonce, arrondie. */
  readonly x: number;
  readonly y: number;
  /**
   * Direction du couloir, quantifiee (voir `CHARGE_DIR_SCALE`).
   *
   * ⚠️ **De norme 1 A LA QUANTIFICATION PRES, et pas renormalisee.** L'ecart
   * est d'au plus 1e-4, soit 0,09 px sur toute la longueur — et il est le MEME
   * des deux cotes, ce qui est la seule chose qui compte ici.
   */
  readonly dirX: number;
  readonly dirY: number;
  /** Longueur du couloir, en pixels monde. */
  readonly length: number;
  /** Largeur du couloir, en pixels monde — c'est aussi le diametre du corps qui le traverse. */
  readonly width: number;
  /** Tick de l'annonce : le chargement commence, le rectangle apparait. */
  readonly windupTick: number;
  /** Tick auquel le boss s'elance. Rien ne fait mal avant. */
  readonly startTick: number;
  /** Tick auquel il arrive au bout du couloir. */
  readonly endTick: number;
}

/**
 * Construit une charge visant `(targetX, targetY)` depuis `(x, y)` au tick
 * `tick`.
 *
 * ⚠️ **LA DIRECTION EST FIGEE ICI, une fois pour toutes.** Le couloir vise,
 * mais **il ne suit pas** : c'est ce qui rend l'esquive possible, et un couloir
 * qui suivrait sa cible serait une taxe, pas une attaque (§4 de la spec).
 * Aucune fonction de ce fichier ne prend de cible en parametre — il n'y a
 * qu'ICI qu'une position de joueur entre dans une charge.
 *
 * ⚠️ **Arrondit l'origine et quantifie la direction**, pour que la valeur
 * construite survive le passage sur le fil A L'IDENTIQUE (voir
 * `CHARGE_DIR_SCALE`). `shared/protocol.test.ts` le verifie par aller-retour.
 *
 * Cible confondue avec l'origine : direction `(1, 0)`. Ce n'est pas une garde
 * de politesse — un joueur exactement sur le boss est atteignable (le corps
 * fait 192 px de large) — et une direction nulle donnerait un couloir de
 * longueur nulle, donc une charge qui ne deplace rien et ne touche personne.
 */
export function makeBossCharge(
  entityId: number,
  x: number,
  y: number,
  targetX: number,
  targetY: number,
  tick: number,
): BossCharge {
  const ox = Math.round(x);
  const oy = Math.round(y);
  const dx = targetX - ox;
  const dy = targetY - oy;
  const norm = Math.hypot(dx, dy);
  const ux = norm > 0 ? dx / norm : 1;
  const uy = norm > 0 ? dy / norm : 0;
  const startTick = tick + BOSS_CHARGE_WINDUP_TICKS;
  return {
    entityId,
    x: ox,
    y: oy,
    dirX: Math.round(ux * CHARGE_DIR_SCALE) / CHARGE_DIR_SCALE,
    dirY: Math.round(uy * CHARGE_DIR_SCALE) / CHARGE_DIR_SCALE,
    length: BOSS_CHARGE_LENGTH_PX,
    width: BOSS_CHARGE_WIDTH_PX,
    windupTick: tick,
    startTick,
    endTick: startTick + BOSS_CHARGE_TICKS,
  };
}

/**
 * La charge PILOTE-t-elle la position du boss au tick `tick` ?
 *
 * Vrai du chargement (ou il le tient immobile a l'origine) jusqu'a la fin de la
 * traversee. C'est ce predicat, jamais la simple presence d'une charge, qui dit
 * qu'une charge agit — meme discipline que `ZoneField.aliveAt` : une charge
 * finie reste en memoire, inerte, pour que le rejeu puisse la retrouver.
 *
 * ⚠️ **Le boss est immobile PENDANT LE CHARGEMENT, et c'est une decision.** Un
 * boss qui continuerait de marcher pendant que son couloir est affiche
 * laisserait l'origine du rectangle derriere lui : le dessin mentirait sur d'ou
 * part la charge, et l'esquive porterait sur une information fausse.
 */
export function chargeHoldsAt(charge: BossCharge, tick: number): boolean {
  return tick >= charge.windupTick && tick <= charge.endTick;
}

/**
 * La charge FAIT-elle mal au tick `tick` ?
 *
 * ⚠️ **RIEN NE FAIT MAL PENDANT LE CHARGEMENT** (§4 de la spec) : c'est ce qui
 * rend le telegraphe sur, et c'est ce qui donne au joueur sa fenetre de
 * reaction. La borne basse est STRICTE — au tick de depart, la progression vaut
 * encore 0 et le corps n'a pas bouge d'un pixel ; ce qui blesse, c'est le corps
 * **en mouvement**. Meme distinction que `ZoneField.slowsAt` face a `aliveAt`,
 * et pour une raison voisine : un tick d'ecart sur un effet, c'est un tick de
 * trop.
 */
export function chargeHurtsAt(charge: BossCharge, tick: number): boolean {
  return tick > charge.startTick && tick <= charge.endTick;
}

/**
 * Fraction du couloir parcourue au tick `tick`, dans `[0, 1]`.
 *
 * Bornee aux deux bouts : `0` pendant tout le chargement, `1` une fois arrive.
 * Purement arithmetique sur des entiers — c'est ce qui la rend identique des
 * deux cotes du fil, sans un octet echange apres l'annonce.
 */
export function chargeProgressAt(charge: BossCharge, tick: number): number {
  const span = charge.endTick - charge.startTick;
  if (span <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, (tick - charge.startTick) / span));
}

/**
 * Position du boss au tick `tick`, ecrite dans `out` (`out[0]` = x, `out[1]` =
 * y).
 *
 * Ecrit dans un tampon plutot que d'allouer une paire : appelee a chaque tick
 * par `Horde.step`, meme discipline que `FlowField.sampleDirection`.
 */
export function chargePointAt(charge: BossCharge, tick: number, out: Float32Array): void {
  const t = chargeProgressAt(charge, tick) * charge.length;
  out[0] = charge.x + charge.dirX * t;
  out[1] = charge.y + charge.dirY * t;
}
