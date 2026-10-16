import {
  CONTACT_DAMAGE,
  CONTACT_INTERVAL_TICKS,
  CONTACT_RADIUS,
  FLOWFIELD_CELL,
  MAP_SIZE,
  PLAYER_SPEED,
} from '@shared/constants';
import {
  CONVOI_ESCORT_RADIUS,
  CONVOI_RADIUS,
  EVENT_DURATION_TICKS,
  EVENT_KIND,
  EVENT_OUTCOME,
  FORGE_RADIUS,
  SCEAU_RADIUS,
} from '@shared/evenements';
import type { FlowField } from '@shared/flowfield';
import { nudgeOutOfObstacle, type ObstacleField } from '@shared/waves';
import { moveOnMap } from '@shared/worldmap';

/**
 * Les evenements bonus (etape 14), cote SERVEUR seul : ou ils naissent et
 * comment ils avancent. Aucun client ne place ni ne simule un evenement — il
 * lit ses points dans `EVENT_START` et son etat dans `EVENT_STATE`. Rien a
 * rejouer, donc rien a garder deterministe entre deux machines : seul le
 * salon fait foi.
 */

/** Distance entre le centre des vivants et le site (§2.2). Pres d'un bord, plus pres : le « ~ » du design. */
export const EVENT_SPAWN_DISTANCE = 1200;
/** Deux sceaux voisins sont a 800 px l'un de l'autre (rayons 400, 462, 566 px pour N = 2, 3, 4). */
export const SCEAUX_SPACING = 800;
/** 20 s CUMULEES : un sceau vide suspend la progression, il ne la fait pas redescendre. */
export const SCEAUX_HOLD_TICKS = 600;
export const FORGE_HOLD_TICKS = 900;
export const FORGE_HOLD_TICKS_SOLO = 450;
/**
 * Immobile se lit sur l'ENTREE, pas sur le deplacement (§3.2) : un joueur
 * pousse par un gardien ou la horde ne bouge pas de son fait. A la manette,
 * une derive de stick sous ~10/127 ne casse pas la canalisation. Et c'est sans
 * etat : aucune position du tick d'avant a retenir.
 */
export const FORGE_STILL_SPEED = 20;
export const CONVOI_DISTANCE = 1500;
/** 25 s de trajet au mieux, sur 60. */
export const CONVOI_SPEED = 60;
export const CONVOI_HP = 400;
export const CONVOI_HP_SOLO = 800;
export const CONVOI_CONTACT_RADIUS = CONVOI_RADIUS + CONTACT_RADIUS / 2;
export const CONVOI_CONTACT_DAMAGE = CONTACT_DAMAGE;
/** 16 PV/s pour un ennemi colle, 80 PV/s au plus : un chariot noye tient 5 s. */
export const CONVOI_MAX_HITTERS = 5;
export const CONVOI_ARRIVAL_RADIUS = 32;

export interface EventPoint {
  x: number;
  y: number;
}

/** Ce que `placeEvent` decide, et ce que `EVENT_START` transporte (plus `solo`, qui reste ici). */
export interface EventPlan {
  kind: number;
  /** Les sceaux ; la forge ; le depart puis l'arrivee du convoi. Entiers, dans la carte, hors mur. */
  points: EventPoint[];
  /** Un seul vivant au depart : forge en 15 s, chariot a 800 PV. FIGE pour tout l'evenement. */
  solo: boolean;
}

/** Ce qu'un evenement lit d'un joueur. `PlayerState` le satisfait tel quel. */
export interface EventPlayer {
  readonly x: number;
  readonly y: number;
  readonly hp: number;
  /** Axe d'entree normalise, dans [-1, 1] (`Room#applyInput`). */
  readonly moveX: number;
  readonly moveY: number;
}

/** Ce qu'un convoi lit de la horde. `Horde` le satisfait tel quel. */
export interface EventHorde {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
}

const sortieX = new Float32Array(1);
const sortieY = new Float32Array(1);

/**
 * Borne a la carte, sort du mur, arrondit au pixel : le point voyage en
 * `int16`.
 *
 * ⚠️ **Un second nudge, sur les coordonnees ARRONDIES.** `nudgeOutOfObstacle`
 * confirme la cellule libre sur la position FRACTIONNAIRE ; l'arrondi au
 * pixel qui suit peut, tout pres d'une frontiere de cellule, basculer le
 * point dans la cellule voisine — muree, elle. Mesure sur une vraie carte
 * generee (coins et cotes en eau) : un sceau pouvait ainsi atterrir sur une
 * cellule muree. Le second appel revoit la cellule des coordonnees deja
 * arrondies ; s'il ne bascule rien (le cas courant), il rend exactement les
 * memes entiers. S'il doit nudger, il rend le CENTRE d'une cellule
 * (`(n + 0.5) x FLOWFIELD_CELL`, deja entier puisque `FLOWFIELD_CELL` est
 * pair) : un second arrondi n'y change plus rien, aucun aller-retour possible.
 */
function poser(obstacles: ObstacleField, x: number, y: number): EventPoint {
  const bx = Math.min(MAP_SIZE, Math.max(0, x));
  const by = Math.min(MAP_SIZE, Math.max(0, y));
  nudgeOutOfObstacle(obstacles, bx, by, sortieX, sortieY, 0);
  const rx = Math.round(sortieX[0] ?? bx);
  const ry = Math.round(sortieY[0] ?? by);
  nudgeOutOfObstacle(obstacles, rx, ry, sortieX, sortieY, 0);
  return { x: Math.round(sortieX[0] ?? rx), y: Math.round(sortieY[0] ?? ry) };
}

const distance = (a: EventPoint, b: EventPoint): number => Math.hypot(a.x - b.x, a.y - b.y);

/** Nombre d'essais de recentrage avant le dernier recours (le centre de la carte). */
const RECENTRAGE_ESSAIS = 12;

/**
 * Pose un groupe de points (un site seul, ou l'anneau des sceaux) sur la
 * terre ferme, en gardant leur geometrie (l'ecart entre eux, l'orientation
 * de l'anneau), meme pres d'un rivage ou d'un coin de carte.
 *
 * Sur une VRAIE carte (§ carte, cotes en eau), poser chaque point separement
 * (par `poser`, qui nudge vers la cellule libre la plus proche) peut faire
 * converger PLUSIEURS points de l'anneau vers la meme etroite bande de terre
 * — mesure : sur 2 coins sur 4, 100 % des graines, jusqu'a deux sceaux sur le
 * meme pixel. `poser` reste correct pour un point isole pres d'un mur local
 * (une tache de rochers au milieu de l'ile) ; c'est l'anneau ENTIER tombant
 * en pleine mer qui n'a pas de reponse locale.
 *
 * La reponse : tenter le centre voulu (`cx`, `cy`), poser tous les points, et
 * accepter seulement si AUCUN point n'a ete deplace de plus de
 * `SCEAU_RADIUS` par le nudge et (s'il y en a plusieurs) si toute paire reste
 * a plus de `2 x SCEAU_RADIUS`. Sinon, retenter en avancant le centre vers le
 * centre de la carte — toujours cote terre, loin du rivage — par pas egaux,
 * jusqu'a `RECENTRAGE_ESSAIS` fois ; le DERNIER essai pose exactement sur le
 * centre de la carte et est retenu quoi qu'il arrive : il n'y a rien de mieux
 * a tenter, et c'est le seul point de toute l'ile garanti loin de tout rivage
 * (`SPAWN_CLEARANCE` dans `shared/worldmap.ts`).
 *
 * Deterministe (aucun tirage, seule la geometrie varie) et bornee a
 * `RECENTRAGE_ESSAIS + 1` essais, chacun `O(points²)` pour les paires —
 * `points` vaut au plus 4 (un sceau par joueur).
 */
function poserGroupe(
  obstacles: ObstacleField,
  cx: number,
  cy: number,
  bruts: (cx: number, cy: number) => readonly EventPoint[],
): EventPoint[] {
  const centreX = MAP_SIZE / 2;
  const centreY = MAP_SIZE / 2;
  let dernier: EventPoint[] = [];
  for (let i = 0; i <= RECENTRAGE_ESSAIS; i++) {
    const t = i / RECENTRAGE_ESSAIS;
    const vx = i === RECENTRAGE_ESSAIS ? centreX : cx + (centreX - cx) * t;
    const vy = i === RECENTRAGE_ESSAIS ? centreY : cy + (centreY - cy) * t;
    const brut = bruts(vx, vy);
    const points = brut.map((p) => poser(obstacles, p.x, p.y));
    dernier = points;
    const deplaceTrop = points.some((p, k) => distance(p, brut[k] ?? p) > SCEAU_RADIUS);
    let colles = false;
    for (let a = 0; a < points.length && !colles; a++) {
      const pa = points[a];
      if (!pa) {
        continue;
      }
      for (let b = a + 1; b < points.length && !colles; b++) {
        const pb = points[b];
        if (pb && distance(pa, pb) <= 2 * SCEAU_RADIUS) {
          colles = true;
        }
      }
    }
    if (!deplaceTrop && !colles) {
      return points;
    }
  }
  return dernier;
}

/**
 * Le genre et les points d'un evenement (§2.2). Le genre vient de `seed % 3`,
 * l'angle des bits `8..31` — disjoints. Le site est a `EVENT_SPAWN_DISTANCE`
 * du CENTRE des vivants (pas du joueur cible par la vague : l'evenement
 * s'adresse a l'equipe), puis posee sur la terre ferme par `poserGroupe`
 * (voir sa doc) : jamais en pleine mer, et pour les sceaux, jamais deux
 * sceaux a moins de `2 x SCEAU_RADIUS`.
 *
 * ⚠️ **N sceaux pour N vivants**, pas « 3 a 4, 2 a 2 » : le design valide dit
 * « un sceau par joueur ». Sans vivant, le centre vaut (0, 0) : le salon ne
 * l'appelle pas ainsi, mais rien ici ne rend `NaN`.
 */
export function placeEvent(
  seed: number,
  vivants: readonly { x: number; y: number }[],
  obstacles: ObstacleField,
): EventPlan {
  const n = Math.max(1, vivants.length);
  let cx = 0;
  let cy = 0;
  for (const p of vivants) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  const kind = seed % 3;
  const theta = ((seed >>> 8) / 0x100_0000) * Math.PI * 2;
  const solo = vivants.length <= 1;
  const spawnX = cx + Math.cos(theta) * EVENT_SPAWN_DISTANCE;
  const spawnY = cy + Math.sin(theta) * EVENT_SPAWN_DISTANCE;
  if (kind === EVENT_KIND.SCEAUX && !solo) {
    const rayon = SCEAUX_SPACING / (2 * Math.sin(Math.PI / vivants.length));
    const points = poserGroupe(obstacles, spawnX, spawnY, (vx, vy) =>
      vivants.map((_, k) => {
        const a = theta + (2 * Math.PI * k) / vivants.length;
        return { x: vx + Math.cos(a) * rayon, y: vy + Math.sin(a) * rayon };
      }),
    );
    return { kind, points, solo };
  }
  const [site] = poserGroupe(obstacles, spawnX, spawnY, (vx, vy) => [{ x: vx, y: vy }]);
  if (!site) {
    // Inatteignable : `poserGroupe` rend toujours au moins un point.
    return { kind, points: [], solo };
  }
  if (kind !== EVENT_KIND.CONVOI) {
    return { kind, points: [site], solo };
  }
  // Le convoi va vers le centre de la carte : l'arrivee reste toujours dedans.
  let dx = MAP_SIZE / 2 - site.x;
  let dy = MAP_SIZE / 2 - site.y;
  let d = Math.hypot(dx, dy);
  if (d < 1) {
    dx = Math.cos(theta);
    dy = Math.sin(theta);
    d = 1;
  }
  const arriveeX = site.x + (dx / d) * CONVOI_DISTANCE;
  const arriveeY = site.y + (dy / d) * CONVOI_DISTANCE;
  const [arrivee] = poserGroupe(obstacles, arriveeX, arriveeY, (vx, vy) => [{ x: vx, y: vy }]);
  return { kind, points: [site, arrivee ?? site], solo };
}

/**
 * Un evenement en cours, cote serveur (§3). `step` rend `null` tant qu'il
 * continue, sinon son issue. Les joueurs a `hp <= 0` ne comptent JAMAIS — ni
 * occupant, ni forgeron, ni escorte.
 */
export class EventRun {
  readonly kind: number;
  readonly points: readonly EventPoint[];
  /** Le chariot (convoi) : sa position SERVEUR, que `EVENT_STATE` transporte. */
  readonly cart: EventPoint;
  readonly cartHpMax: number;
  #cartHp: number;
  #elapsed = 0;
  #held = 0;
  readonly #holdTicks: number;
  #arrived = false;
  readonly #trajet: number;
  readonly #field: FlowField;
  readonly #dir = new Float32Array(2);

  constructor(plan: EventPlan, field: FlowField) {
    this.kind = plan.kind;
    this.points = plan.points;
    this.#field = field;
    const depart = plan.points[0] ?? { x: 0, y: 0 };
    const arrivee = plan.points[1] ?? depart;
    this.cart = { x: depart.x, y: depart.y };
    this.cartHpMax = plan.solo ? CONVOI_HP_SOLO : CONVOI_HP;
    this.#cartHp = this.cartHpMax;
    this.#holdTicks =
      plan.kind === EVENT_KIND.FORGE
        ? plan.solo
          ? FORGE_HOLD_TICKS_SOLO
          : FORGE_HOLD_TICKS
        : SCEAUX_HOLD_TICKS;
    this.#trajet = Math.max(1, Math.hypot(arrivee.x - depart.x, arrivee.y - depart.y));
    if (plan.kind === EVENT_KIND.CONVOI) {
      // ⚠️ **UN SEUL BFS par convoi**, enracine sur l'arrivee : une ligne
      // droite peut traverser un mur ou de l'eau.
      field.update(arrivee.x, arrivee.y);
    }
  }

  /** Ticks VIVANTS ecoules : le salon n'appelle pas `step` pendant un gel ni pendant la rampe. */
  get elapsed(): number {
    return this.#elapsed;
  }

  get cartHp(): number {
    return this.#cartHp;
  }

  /** De 0 a 1. Le convoi : `1 - distance(chariot, E) / distance(S, E)`, borne ; 1 a l'arrivee. */
  get progress(): number {
    if (this.kind !== EVENT_KIND.CONVOI) {
      return Math.min(1, this.#held / this.#holdTicks);
    }
    if (this.#arrived) {
      return 1;
    }
    const e = this.points[1] ?? this.cart;
    const reste = Math.hypot(e.x - this.cart.x, e.y - this.cart.y);
    return Math.min(1, Math.max(0, 1 - reste / this.#trajet));
  }

  step(players: readonly EventPlayer[], horde: EventHorde, dt: number): number | null {
    this.#elapsed++;
    const vivants = players.filter((p) => p.hp > 0);
    if (this.kind === EVENT_KIND.CONVOI) {
      const issue = this.#stepConvoi(vivants, horde, dt);
      if (issue !== null) {
        return issue;
      }
    } else {
      if (this.#tenu(vivants)) {
        this.#held++;
      }
      if (this.#held >= this.#holdTicks) {
        return EVENT_OUTCOME.REUSSI;
      }
    }
    return this.#elapsed >= EVENT_DURATION_TICKS ? EVENT_OUTCOME.EXPIRE : null;
  }

  /** Les octets d'`EVENT_STATE`, deja quantifies (§6.1). Zeros hors convoi. */
  wireState(): { progress: number; cartX: number; cartY: number; cartHp: number } {
    const convoi = this.kind === EVENT_KIND.CONVOI;
    return {
      progress: Math.floor(255 * this.progress),
      cartX: convoi ? Math.round(this.cart.x) : 0,
      cartY: convoi ? Math.round(this.cart.y) : 0,
      cartHp: convoi ? Math.ceil((255 * this.#cartHp) / this.cartHpMax) : 0,
    };
  }

  /**
   * Sceaux : CHAQUE sceau a au moins un vivant (deux dans le meme n'en valent
   * qu'un). Forge : un vivant dans le rayon ET immobile a l'entree.
   */
  #tenu(vivants: readonly EventPlayer[]): boolean {
    if (this.kind === EVENT_KIND.SCEAUX) {
      return this.points.every((s) =>
        vivants.some((p) => Math.hypot(p.x - s.x, p.y - s.y) <= SCEAU_RADIUS),
      );
    }
    const f = this.points[0];
    if (!f) {
      return false;
    }
    return vivants.some(
      (p) =>
        Math.hypot(p.x - f.x, p.y - f.y) <= FORGE_RADIUS &&
        Math.hypot(p.moveX, p.moveY) * PLAYER_SPEED < FORGE_STILL_SPEED,
    );
  }

  #stepConvoi(vivants: readonly EventPlayer[], horde: EventHorde, dt: number): number | null {
    const e = this.points[1] ?? this.cart;
    // Il n'avance QUE s'il est escorte.
    if (
      vivants.some((p) => Math.hypot(p.x - this.cart.x, p.y - this.cart.y) <= CONVOI_ESCORT_RADIUS)
    ) {
      let dx = e.x - this.cart.x;
      let dy = e.y - this.cart.y;
      const d = Math.hypot(dx, dy);
      // A moins d'une cellule, droit sur E : la cellule cible n'a pas de direction.
      this.#dir[0] = 0;
      this.#dir[1] = 0;
      if (d > FLOWFIELD_CELL) {
        this.#field.sampleDirection(this.cart.x, this.cart.y, this.#dir);
      }
      if ((this.#dir[0] ?? 0) !== 0 || (this.#dir[1] ?? 0) !== 0) {
        dx = this.#dir[0] ?? 0;
        dy = this.#dir[1] ?? 0;
      } else if (d > 0) {
        dx /= d;
        dy /= d;
      }
      const avance = Math.min(CONVOI_SPEED * dt, d);
      // ⚠️ Le pas passe par `moveOnMap`, la regle des joueurs : le champ dit
      // ou aller, `moveOnMap` garantit qu'il n'entre jamais dans un mur.
      const f = this.#field;
      const pos = moveOnMap(
        this.cart.x,
        this.cart.y,
        dx * avance,
        dy * avance,
        f.blocked,
        f.cols,
        f.rows,
        f.cellSize,
        MAP_SIZE,
      );
      this.cart.x = pos.x;
      this.cart.y = pos.y;
    }
    if (Math.hypot(e.x - this.cart.x, e.y - this.cart.y) <= CONVOI_ARRIVAL_RADIUS) {
      this.#arrived = true;
      return EVENT_OUTCOME.REUSSI;
    }
    // Les degats : le meme balayage lineaire que `resolveContact`, un seul
    // point, toutes les `CONTACT_INTERVAL_TICKS` ticks VIVANTS. La horde ne le
    // vise pas : il ne prend que ce qui le frole.
    if (this.#elapsed % CONTACT_INTERVAL_TICKS === 0) {
      const r2 = CONVOI_CONTACT_RADIUS * CONVOI_CONTACT_RADIUS;
      let n = 0;
      for (let i = 0; i < horde.count && n < CONVOI_MAX_HITTERS; i++) {
        const hx = (horde.x[i] ?? 0) - this.cart.x;
        const hy = (horde.y[i] ?? 0) - this.cart.y;
        if (hx * hx + hy * hy <= r2) {
          n++;
        }
      }
      this.#cartHp = Math.max(0, this.#cartHp - n * CONVOI_CONTACT_DAMAGE);
      if (this.#cartHp === 0) {
        return EVENT_OUTCOME.DETRUIT;
      }
    }
    return null;
  }
}
