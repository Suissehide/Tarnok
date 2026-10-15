import type { AbilityUsed } from '@shared/abilities';
import type { BossCharge } from '@shared/boss';
import { LEVEL_XP_BASE, MAP_SIZE, TICK_HZ } from '@shared/constants';
import type { EnemyShot } from '@shared/enemy-shots';
import type { Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';
import type { ZoneField } from '@shared/zones';
import { Application, Container, Graphics, Rectangle } from 'pixi.js';

import type {
  ActivePing,
  BlastFlash,
  BossVitals,
  ChainFlashes,
  DamageNumbers,
  DerivedOrbs,
  HitFlashes,
  ObstacleMap,
  OrbFlights,
  PickupTarget,
  ReactionFlashes,
  RenderState,
  RunOverSummary,
} from '../net/client';
import { ASSETS_BASE } from '../ui/config';
import { AbilityRenderer } from './ability-renderer';
import { BehaviorRenderer } from './behavior-renderer';
import { BossBarRenderer } from './boss-bar-renderer';
import { ChainRenderer } from './chain-renderer';
import { ChargeRenderer } from './charge-renderer';
import { DamageNumberRenderer } from './damage-renderer';
import { HordeRenderer } from './horde-renderer';
import { MarkRingRenderer } from './mark-renderer';
import { OrbRenderer } from './orb-renderer';
import { livePings, PingRenderer } from './ping-renderer';
import { PlayerRenderer } from './player-renderer';
import {
  ImpactFlashRenderer,
  ProjectileRenderer,
  ReactionFlashRenderer,
} from './projectile-renderer';
import { buildTerrain } from './terrain-renderer';
import { ZoneRenderer } from './zone-renderer';

/**
 * La scene du jeu : la carte, la horde, et un carre par joueur.
 *
 * Les joueurs restent quatre `Graphics` — a cette echelle, un objet par
 * entite ne coute rien, et rien ne justifierait le batching. La horde, elle,
 * est deleguee a `HordeRenderer` : c'est la ou vit le `ParticleContainer` et
 * l'atlas de la tache 11-12, la decision d'y passer etant venue d'une mesure
 * (etape 1), pas d'une intuition. `Stage` ne fait qu'orchestrer les deux :
 * ordre d'affichage, camera commune, et le rectangle de vue qui sert de
 * culling a la horde (`viewRect`).
 */

/** Un anneau colore par joueur : avec quatre cameras, il faut savoir qui est qui (§6.6). */
/** Une couleur par joueur, celle de son unite du pack (`UNIT_COLORS`) : jaune, bleu, rouge, violet. */
const PLAYER_COLORS = [0xe0b84e, 0x6fa8dc, 0xe06666, 0xc27ba0];

/** §4.5 : vue de dessus, tres legerement ecrasee. Pas d'isometrique. */
const VERTICAL_SQUASH = 0.82;

/** Un calque du monde : il s'attache a la scene, et sait dire si sa texture est posee. */
interface SceneLayer {
  attach(parent: Container): void;
  readonly loaded: boolean;
}

/** Un calque dont la texture est procedurale, donc chargeable sans reseau. */
interface ProceduralLayer extends SceneLayer {
  load(): void;
}

export class Stage {
  readonly #app = new Application();
  readonly #world = new Container();
  /** Joueurs et objets hauts, tries par la hauteur de leurs pieds (`zIndex`). */
  readonly #depth = new Container({ sortableChildren: true });
  /** Les fantomes des joueurs, au-dessus de tout le decor (`PlayerRenderer`). */
  readonly #ghosts = new Container();
  readonly #players = new PlayerRenderer(
    ASSETS_BASE,
    this.#depth,
    this.#ghosts,
    (id) => PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] ?? 0xffffff,
  );
  // Corrigé par rapport au brief : `readonly` assigné dans `init()` ne
  // compile pas sous `strictPropertyInitialization`. Initialisation directe.
  #horde = new HordeRenderer(ASSETS_BASE);
  readonly #zones = new ZoneRenderer();
  readonly #charge = new ChargeRenderer();
  readonly #abilities = new AbilityRenderer();
  readonly #behaviors = new BehaviorRenderer(ASSETS_BASE);
  readonly #marks = new MarkRingRenderer();
  readonly #orbs = new OrbRenderer();
  readonly #projectiles = new ProjectileRenderer();
  readonly #chain = new ChainRenderer();
  readonly #impactFlashes = new ImpactFlashRenderer();
  readonly #reactionFlashes = new ReactionFlashRenderer();
  readonly #bossBar = new BossBarRenderer();
  readonly #damageNumbers = new DamageNumberRenderer();
  readonly #pings = new PingRenderer(
    (id) => PLAYER_COLORS[(id - 1) % PLAYER_COLORS.length] ?? 0xffffff,
  );
  /** Garde `drawObstacles` idempotent : la carte est statique, une seule construction suffit. */
  #obstaclesDrawn = false;
  /** La grille de fond : masquee des que la carte en tuiles la recouvre. */
  readonly #grid = mapBorder();

  /**
   * Les calques du monde, **du sol vers le ciel** : l'ordre de ce tableau EST
   * la hierarchie du §6.6 traduite en z-order.
   *
   * ⚠️ **Les zones EN PREMIER, et le flash de reaction EN DERNIER.** Une zone
   * est du terrain teinte, discret, que rien ne doit masquer les monstres qui
   * s'y trouvent ; la reaction est l'evenement le plus rare et le plus mortel
   * du jeu, et elle passe devant tout le reste. Les orbes (au sol) avant la
   * horde ; les projectiles et les flashs apres, pour rester visibles par-
   * dessus les monstres qu'ils visent.
   *
   * ⚠️ **Le couloir de charge juste apres les zones** (etape 6a, tache 5 bis) :
   * c'est un aplat au sol comme elles, et il doit passer SOUS le boss qui va le
   * traverser — un rectangle par-dessus la creature masquerait precisement ce
   * qu'on regarde.
   *
   * ⚠️ **Les anneaux de marque juste apres les zones** (tache 13) : ils se
   * posent SOUS les pieds des creatures, donc ils doivent passer sous elles.
   * Au-dessus des zones, parce qu'ils marquent un ennemi individuel sur le sol
   * que la zone vient de teindre en grand.
   *
   * ⚠️ **La chaine de Foudre juste apres les projectiles** (etape 5b, tache
   * 3) : elle relie des ennemis par un trait, donc elle doit rester lisible
   * par-dessus leurs sprites — le meme raisonnement qui place deja les
   * projectiles au-dessus de la horde.
   *
   * ⚠️ **La barre du boss EN DERNIER** (etape 6a, tache 5) : c'est une lecture,
   * pas un effet, et aucun flash ne doit la masquer a l'instant ou l'on regarde
   * si le boss va tomber.
   */
  readonly #layers: readonly SceneLayer[] = [
    this.#zones,
    this.#charge,
    // Les verbes (etape 8) : la zone d'un Rempart et le leurre d'un Appat sont
    // poses au sol comme le couloir de charge, donc sous les creatures.
    this.#abilities,
    // Les comportements (cercle du kamikaze, aura du chaman) : au sol, sous
    // les creatures, comme les verbes.
    this.#behaviors,
    this.#marks,
    this.#orbs,
    this.#horde,
    this.#projectiles,
    this.#chain,
    this.#impactFlashes,
    this.#reactionFlashes,
    this.#bossBar,
    // Les pings (etape 9) : une lecture, comme la barre du boss ; juste sous
    // les chiffres de degats, qui restent tout en haut.
    this.#pings,
    // ⚠️ **Les chiffres de degats TOUT EN HAUT** (etape 8) : ils se LISENT, et
    // une lecture ne doit etre masquee par rien — meme raison que la barre du
    // boss au-dessus des flashs, poussee d'un cran plus loin parce qu'un
    // nombre illisible ne vaut pas mieux qu'un nombre absent.
    this.#damageNumbers,
  ];

  /**
   * Les calques dont la texture est PROCEDURALE (canevas 2D) : aucun fetch
   * reseau, donc rien qui puisse echouer comme l'atlas de la horde. C'est
   * exactement `#layers` moins `#horde`, dont le chargement est asynchrone et
   * a son propre rattrapage d'echec dans `init`.
   *
   * ⚠️ **`#chain` n'a rien de procedural (pas de canevas 2D, une polyligne
   * tracee au vol) et figure quand meme ici** : son `load()` ne fait que
   * poser un booleen, pour que `Stage.layersLoaded` continue de compter tous
   * ses calques par le meme protocole — voir `ChainRenderer`.
   */
  readonly #procedural: readonly ProceduralLayer[] = [
    this.#zones,
    this.#charge,
    this.#abilities,
    this.#behaviors,
    this.#marks,
    this.#orbs,
    this.#projectiles,
    this.#chain,
    this.#impactFlashes,
    this.#reactionFlashes,
    this.#bossBar,
    this.#pings,
    this.#damageNumbers,
  ];

  async init(parent: HTMLElement): Promise<void> {
    await this.#app.init({
      resizeTo: parent,
      background: 0x14110f,
      antialias: true,
      // Un bullet heaven passe son temps a bouger : la resolution native evite
      // le flou sur ecran dense sans rien couter a ce stade.
      resolution: window.devicePixelRatio,
      autoDensity: true,
    });
    parent.appendChild(this.#app.canvas);

    this.#world.scale.set(1, VERTICAL_SQUASH);
    this.#app.stage.addChild(this.#world);
    // Les fleches de bord (etape 9) : en coordonnees ECRAN, donc hors de `#world`.
    // Ajoutees APRES le monde, elles passent au-dessus de lui.
    this.#pings.attachScreen(this.#app.stage);
    this.#world.addChild(this.#grid);

    // Les calques du monde : apres la grille, avant les carres des joueurs
    // (ajoutes plus tard via `#spriteFor`), sinon les joueurs disparaissent
    // sous la horde. Voir `composeWorld` — c'est la seule partie de `init` que
    // la suite sait executer.
    this.composeWorld(this.#world);
    // Les joueurs et les arbres par-dessus tous les calques, puis leurs fantomes.
    this.#world.addChild(this.#depth, this.#ghosts);

    // Constat I4 : sans ce try/catch, un atlas absent (404 sur le manifeste,
    // deploiement ou l'atlas n'a pas ete depose sur MinIO) fait echouer cette
    // promesse. `main.ts` fait `await stage.init(...)` au niveau module ; une
    // rejection y arrete l'evaluation du module AVANT que les gestionnaires de
    // clic ne soient installes — lobby mort, sans le moindre message. Mieux
    // vaut demarrer sans horde visible que bloquer tout le jeu pour un asset
    // manquant. `HordeRenderer.draw` sait deja ne rien faire tant que
    // `#loaded` est faux.
    try {
      await this.#horde.load();
    } catch (cause) {
      console.error(
        "atlas de la horde indisponible, la horde ne sera pas dessinee. L'a-t-on deploye sur MinIO ? (voir docs/plans/2026-08-24-etape-2-resultats.md §5.1)",
        cause,
      );
    }
  }

  /**
   * Attache les calques du monde dans leur ordre d'affichage, puis charge
   * leurs textures procedurales.
   *
   * ⚠️ **Separee de `init` PARCE QUE `init` construit une `Application` Pixi**
   * — un contexte WebGL qu'aucun environnement de test ne fournit. Tant que
   * cette composition vivait dans `init`, retirer un calque entier (« les
   * zones ni attachees ni chargees ») laissait la suite verte a 170 tests.
   * Ceci s'execute sans GPU : voir `stage.test.ts`.
   *
   * `HordeRenderer.load` n'en fait pas partie : elle va sur le reseau, et son
   * echec a un traitement a elle dans `init`.
   */
  composeWorld(world: Container): void {
    for (const layer of this.#layers) {
      layer.attach(world);
    }
    for (const layer of this.#procedural) {
      layer.load();
    }
  }

  /**
   * Etat de chargement de chaque calque du monde, dans l'ordre d'affichage.
   * Expose pour le test, comme `boundsArea` sur les renderers : c'est la seule
   * lecture qui distingue « attache » de « charge ».
   */
  get layersLoaded(): readonly boolean[] {
    return this.#layers.map((layer) => layer.loaded);
  }

  get canvas(): HTMLCanvasElement {
    return this.#app.canvas;
  }

  /**
   * Branche la boucle de rendu.
   *
   * ⚠️ **`frame` dessine tout, y compris les joueurs.** Le ticker n'appelle
   * plus `draw` lui-meme depuis la tache 9 bis : sinon la moitie de l'image
   * (les carres des joueurs et la camera) resterait hors de `composeFrame`,
   * donc hors de portee du test — exactement la faille qu'on solde ici.
   */
  run(frame: (now: number, dt: number) => void): void {
    this.#app.ticker.add((ticker) => {
      frame(performance.now(), ticker.deltaMS / 1000);
    });
  }

  draw(state: RenderState): void {
    this.#players.draw(
      state.players,
      (id) => state.classes?.get(id) ?? 0,
      state.localId,
      performance.now(),
    );

    this.#centerOn(state);
  }

  /**
   * Force un rendu immediat, sans attendre le ticker.
   *
   * Le ticker Pixi passe par `requestAnimationFrame`, suspendu dans un onglet
   * en arriere-plan : la scene peut etre a jour en memoire (apres `draw` /
   * `drawHorde`) sans que le canevas ne le reflete jamais. Utile a la poignee
   * de debogage `__tarnok` (developpement uniquement), mais reste publique et
   * anodine — elle ne fuit pas l'`Application` Pixi complete.
   */
  renderNow(): void {
    this.#app.renderer.render(this.#app.stage);
  }

  /**
   * Convertit un point ECRAN (par exemple la position du curseur, relative au
   * canevas) en coordonnees MONDE, via la MEME camera que celle qui positionne
   * `#world` dans `#centerOn` — jamais une reconstruction approximative a
   * cote. C'est la regle de la tache 13 : le curseur vit en coordonnees
   * ecran, la visee est une direction monde, et faire cette conversion
   * ailleurs qu'ici ferait deriver la visee des que la camera bouge.
   *
   * `VERTICAL_SQUASH` n'affecte que l'axe Y (§4.5 : vue de dessus ecrasee),
   * d'ou la division qui n'apparait que sur `y`.
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: screenX - this.#world.x,
      y: (screenY - this.#world.y) / VERTICAL_SQUASH,
    };
  }

  /** Rectangle du monde actuellement visible, pour le culling. */
  viewRect(): Rectangle {
    return new Rectangle(
      -this.#world.x,
      -this.#world.y / VERTICAL_SQUASH,
      this.#app.screen.width,
      this.#app.screen.height / VERTICAL_SQUASH,
    );
  }

  /**
   * Dessine les obstacles de la carte (tache 28) — appele une seule fois,
   * depuis le `onMapReady` passe a `GameClient`, qui ne se declenche qu'a la
   * reception de WELCOME (voir sa doc dans `client.ts`). `map` porte le MEME
   * masque que celui applique aux `FlowField` du client : le rendu ne
   * regenere jamais sa propre carte, ce qui garantirait sinon des rochers
   * dessines a des cellules differentes de celles ou les monstres butent
   * reellement.
   */
  drawObstacles(map: ObstacleMap): Promise<void> {
    if (this.#obstaclesDrawn) {
      return Promise.resolve();
    }
    this.#obstaclesDrawn = true;
    // La carte en tuiles (`terrain-renderer.ts`) sous TOUS les calques, index
    // 0. Si une planche manque, l'ancien dessin reprend : index 1, juste
    // au-dessus de la grille, en dessous des orbes/horde/projectiles/flashs et
    // des carres de joueurs — les obstacles sont du terrain, pas un calque qui
    // doit passer devant les entites.
    // Rendue : l'ecran de chargement attend que le terrain soit pose.
    return buildTerrain(map.world, ASSETS_BASE)
      .then(({ ground, tall }) => {
        this.#world.addChildAt(ground, 0);
        // Les arbres et grands details, tries avec les joueurs par leurs pieds.
        for (const t of tall) {
          this.#depth.addChild(t);
        }
        this.#grid.visible = false;
      })
      .catch((cause: unknown) => {
        console.error('planches du terrain indisponibles, obstacles en aplat', cause);
        this.#world.addChildAt(mapObstacles(map.mask, map.cols, map.rows, map.cellSize), 1);
      });
  }

  /**
   * `timeMs` est l'horloge murale de l'animation — voir `HordeRenderer.draw`.
   *
   * `heldEntityId` est l'entite dont le clip reste sur sa PREMIERE image
   * (tache 13) : le boss qui arme sa charge. `null` le reste du temps, ce qui
   * est le cas courant — voir `clipFrameIndex`.
   */
  drawHorde(horde: Horde, timeMs: number, heldEntityId: number | null): void {
    this.#horde.draw(horde, this.viewRect(), timeMs, heldEntityId);
  }

  /**
   * `tick` decide quelles zones sont encore vivantes, `timeMs` (horloge murale)
   * ne fait que les animer — voir `ZoneRenderer.draw`.
   */
  drawZones(zones: ZoneField, tick: number, timeMs: number): void {
    this.#zones.draw(zones, tick, this.viewRect(), timeMs);
  }

  /**
   * Le couloir de la charge du boss (etape 6a, tache 5 bis). Ni vue ni horloge
   * murale : un seul quad, donc rien a cadrer, et son opacite se derive du TICK
   * — le meme que celui qui deplace le boss. Voir `ChargeRenderer.draw`.
   */
  drawBossCharge(charge: BossCharge | null, tick: number): void {
    this.#charge.draw(charge, tick);
  }

  /** Les verbes annonces (etape 8) : le tick decide de leur vie, `timeMs` les anime. */
  /** Les cercles des comportements et les explosions — voir `BehaviorRenderer`. */
  drawBehaviors(
    horde: Horde,
    blasts: readonly BlastFlash[],
    shots: readonly EnemyShot[],
    timeMs: number,
  ): void {
    this.#behaviors.draw(horde, blasts, shots, this.viewRect(), timeMs);
  }

  drawAbilities(events: readonly AbilityUsed[], tick: number, timeMs: number): void {
    this.#abilities.draw(events, tick, timeMs);
  }

  /** `tick` decide quelles marques sont encore vivantes, `timeMs` les anime — voir `MarkRingRenderer.draw`. */
  drawMarks(horde: Horde, tick: number, timeMs: number): void {
    this.#marks.draw(horde, tick, this.viewRect(), timeMs);
  }

  /**
   * `players` sont les positions DESSINEES des joueurs (`RenderState.players`) :
   * une orbe capturee rejoint celui qui l'a ramassee — voir `orbFlightFraction`.
   */
  drawOrbs(
    orbs: DerivedOrbs,
    flights: OrbFlights,
    players: readonly PickupTarget[],
    timeMs: number,
  ): void {
    this.#orbs.draw(orbs, flights, players, this.viewRect(), timeMs);
  }

  drawProjectiles(projectiles: Projectiles): void {
    this.#projectiles.draw(projectiles, this.viewRect());
  }

  /**
   * La polyligne de la chaine de Foudre (etape 5b, tache 3, tour de
   * correction 1). `nowMs` est l'horloge murale, comme `drawImpactFlashes` :
   * le chemin est deja figé dans `flashes` — voir `ChainRenderer.draw`.
   */
  drawChain(flashes: ChainFlashes, nowMs: number): void {
    this.#chain.draw(flashes, nowMs);
  }

  /** `nowMs` doit etre la meme horloge murale que celle passee a `GameClient` (voir `ImpactFlashRenderer`). */
  drawImpactFlashes(flashes: HitFlashes, nowMs: number): void {
    this.#impactFlashes.draw(flashes, nowMs);
  }

  /** Meme horloge murale que `drawImpactFlashes` — voir `ReactionFlashRenderer`. */
  drawReactionFlashes(flashes: ReactionFlashes, nowMs: number): void {
    this.#reactionFlashes.draw(flashes, nowMs);
  }

  /**
   * La secousse de camera (etape 8) : une explosion et une reaction se SENTENT.
   *
   * ⚠️ **Posee sur `app.stage`, JAMAIS sur `#world`.** `screenToWorld` et
   * `viewRect` derivent tous les deux de `#world.x/y` : secouer le monde aurait
   * fait trembler la VISEE avec l'image, c'est-a-dire que le tir serait parti a
   * cote pendant la secousse. Le parent, lui, deplace ce qui est dessine sans
   * rien dire a la camera — la conversion curseur -> monde reste exactement
   * celle du §13, inchangee.
   *
   * ⚠️ **`prefers-reduced-motion` coupe l'effet, pas le jeu.** Une secousse est
   * du confort ; la refuser ne retire aucune information (le flash et la gerbe
   * disent deja l'explosion).
   */
  shakeCamera(hits: HitFlashes, reactions: ReactionFlashes, nowMs: number): void {
    const { x, y } = prefersReducedMotion() ? { x: 0, y: 0 } : cameraShake(hits, reactions, nowMs);
    this.#app.stage.x = x;
    this.#app.stage.y = y;
  }

  /**
   * La barre de vie du boss (etape 6a, tache 5). Ni vue ni horloge : elle ne
   * cadre rien (il n'y a qu'un boss, donc deux quads au pire) et n'anime rien —
   * elle suit une position et une fraction de PV. Voir `BossBarRenderer.draw`.
   */
  drawBossBar(horde: Horde, boss: BossVitals | null): void {
    this.#bossBar.draw(horde, boss);
  }

  /** `nowMs` : la meme horloge murale que les flashs — voir `DamageNumbers`. */
  drawDamageNumbers(numbers: DamageNumbers, nowMs: number): void {
    this.#damageNumbers.draw(numbers, nowMs);
  }

  /** Coordonnees MONDE -> ECRAN, la reciproque exacte de `screenToWorld`. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    return { x: x + this.#world.x, y: y * VERTICAL_SQUASH + this.#world.y };
  }

  drawPings(
    pings: ReadonlyMap<number, ActivePing>,
    players: readonly { id: number; x: number; y: number }[],
    localId: number | null,
    tick: number,
    _timeMs: number,
  ): void {
    const me = players.find((p) => p.id === localId);
    const allies = me
      ? players
          .filter((p) => p.id !== localId)
          .map((p) => ({ id: p.id, x: p.x, y: p.y, distance: Math.hypot(p.x - me.x, p.y - me.y) }))
      : [];
    this.#pings.draw(
      livePings(pings, tick),
      allies,
      (x, y) => this.worldToScreen(x, y),
      this.#app.screen.width,
      this.#app.screen.height,
    );
  }

  destroy(): void {
    this.#app.destroy(true, { children: true });
  }

  /** Une camera par joueur (§14) : chacun est centre sur son propre carre. */
  #centerOn(state: RenderState): void {
    const me = state.players.find((p) => p.id === state.localId);
    if (!me) {
      return;
    }
    this.#world.x = this.#app.screen.width / 2 - me.x;
    this.#world.y = this.#app.screen.height / 2 - me.y * VERTICAL_SQUASH;
  }
}

/**
 * Duree d'une secousse, en millisecondes d'horloge murale.
 *
 * Plus COURTE que la vie du flash qui la declenche (220 ms pour un impact,
 * 440 pour une reaction) : la secousse doit etre finie quand l'oeil revient a
 * la lecture du terrain, sinon elle devient un tremblement de fond — c'est le
 * meme raisonnement que le §4.3 sur le flash, *« court, large et genereux… pas
 * un halo permanent »*.
 */
export const SHAKE_MS = 180;

/**
 * Amplitude d'une secousse, en pixels ECRAN.
 *
 * ⚠️ **La reaction secoue plus fort que l'explosion, et c'est le §6.6.** Une
 * reaction est rare, arbitree serveur et mortelle ; une grenade part toutes
 * les une virgule cinq secondes. Si les deux secouaient pareil, la hierarchie
 * *« etat persistant discret, reaction spectaculaire »* se perdrait dans un
 * tremblement continu.
 */
export const SHAKE_BLAST_PX = 5;
export const SHAKE_REACTION_PX = 7;

/**
 * Fenetre de regroupement des secousses, en millisecondes.
 *
 * ⚠️ **C'est le remede au tremblement CONTINU**, signale en jouant : *« trop
 * de vibration de l'ecran si je tape un boss, ca enclenche les effets en
 * boucle »*. Et c'etait inevitable : une secousse par evenement, sur un boss
 * qu'on touche dix fois par seconde avec une arme a souffle, redemarre
 * l'enveloppe avant qu'elle ne soit retombee — donc l'ecran ne se stabilise
 * JAMAIS. Le §6.6 interdit exactement ca pour les flashs (*« court, large et
 * genereux, pas un halo permanent »*) ; la camera n'y echappe pas.
 *
 * Tous les declencheurs nes dans la meme fenetre partagent donc une SEULE
 * enveloppe, calee sur le debut de la fenetre : la secousse dure au plus
 * `SHAKE_MS` puis l'ecran est immobile jusqu'a la fenetre suivante. Le rapport
 * des deux borne le temps passe a trembler — ici 180/420, soit **43 % au pire,
 * et c'est un maximum de construction**, pas une moyenne esperee.
 *
 * ⚠️ **Toujours AUCUN etat.** La fenetre se derive de la naissance du flash
 * (`floor(born / SHAKE_WINDOW_MS)`), pas d'un compteur que `draw` entretiendrait
 * — un accumulateur aurait pu rester bloque en haut si une image sautait,
 * c'est-a-dire un ecran qui tremble pour toujours.
 */
export const SHAKE_WINDOW_MS = 420;

/**
 * Le decalage de camera a appliquer a cet instant, derive des flashs vivants.
 *
 * ⚠️ **Aucun etat, et c'est ce qui rend la secousse sure.** Pas de « trauma »
 * accumule a decrementer image par image : la plus forte secousse encore
 * vivante gagne, et elle s'eteint toute seule. Un accumulateur aurait demande
 * un `dt` fiable (il n'y en a pas dans `draw`) et aurait pu rester bloque en
 * haut si une image sautait — un ecran qui tremble pour toujours.
 *
 * ⚠️ **Les declencheurs sont REGROUPES PAR FENETRE** (etape 8, sur retour de
 * jeu) : sans ca, taper un boss a l'arme de souffle relancait l'enveloppe a
 * chaque coup et l'ecran ne se stabilisait jamais. Voir `SHAKE_WINDOW_MS`.
 *
 * Deux frequences volontairement incommensurables (0,08 et 0,11 rad/ms, soit
 * ~12,7 et ~17,5 Hz) : a frequence egale sur les deux axes, le decalage
 * suivrait une diagonale et lirait comme un GLISSEMENT, pas comme un choc.
 */
export function cameraShake(
  hits: HitFlashes,
  reactions: ReactionFlashes,
  nowMs: number,
): { x: number; y: number } {
  let amplitude = 0;
  let age = 0;
  const retenir = (bornMs: number, max: number): void => {
    // L'enveloppe est calee sur le DEBUT DE LA FENETRE, jamais sur la
    // naissance du flash : c'est ce qui empeche un second coup de relancer une
    // secousse deja en cours. Voir `SHAKE_WINDOW_MS`.
    const fenetre = Math.floor(bornMs / SHAKE_WINDOW_MS) * SHAKE_WINDOW_MS;
    const ageMs = nowMs - fenetre;
    if (ageMs < 0 || ageMs >= SHAKE_MS) {
      return;
    }
    const a = max * (1 - ageMs / SHAKE_MS);
    if (a > amplitude) {
      amplitude = a;
      age = ageMs;
    }
  };
  for (let i = 0; i < hits.count; i++) {
    // Seuls les coups qui le DEMANDENT secouent : sans ce test, dix-sept armes
    // feraient trembler l'ecran a chaque projectile qui touche. C'est le souffle
    // qui le demande par defaut — et le halo qui s'en exclut, parce qu'il pulse
    // sans fin (voir `HitFlashes.shakes`).
    if ((hits.shakes[i] ?? 0) === 1) {
      retenir(hits.bornMs[i] ?? 0, SHAKE_BLAST_PX);
    }
  }
  for (let i = 0; i < reactions.count; i++) {
    retenir(reactions.bornMs[i] ?? 0, SHAKE_REACTION_PX);
  }
  if (amplitude <= 0) {
    return { x: 0, y: 0 };
  }
  return { x: Math.sin(age * 0.08) * amplitude, y: Math.cos(age * 0.11) * amplitude };
}

/** Vrai si le systeme demande qu'on evite les animations non essentielles. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

function mapBorder(): Graphics {
  const grid = new Graphics();
  const step = 500;
  for (let v = 0; v <= MAP_SIZE; v += step) {
    grid.moveTo(v, 0).lineTo(v, MAP_SIZE);
    grid.moveTo(0, v).lineTo(MAP_SIZE, v);
  }
  grid.stroke({ color: 0x2a2420, width: 2 });
  grid.rect(0, 0, MAP_SIZE, MAP_SIZE).stroke({ color: 0x4a3f36, width: 6 });
  return grid;
}

/** Gris pierre, dans la meme famille terreuse que la bordure ci-dessus (§4.5). */
const OBSTACLE_FILL = 0x4f4a42;
const OBSTACLE_STROKE = 0x2f2b26;

/**
 * Coin haut-gauche (coordonnees MONDE) de chaque cellule bloquee de `mask`.
 *
 * PURE, sans Pixi — testable sans navigateur, meme raison que `hudInfo`
 * ci-dessous. C'est cette fonction qui porte « le rendu consulte le MEME
 * masque que le champ de flux » (tache 28) : un masque decale d'une cellule,
 * ou regenere avec une autre graine, se voit directement dans les
 * coordonnees qu'elle rend — voir `stage.test.ts`.
 */
export function obstacleCells(
  mask: Uint8Array,
  cols: number,
  rows: number,
  cellSize: number,
): { x: number; y: number }[] {
  const cells: { x: number; y: number }[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if ((mask[cy * cols + cx] ?? 0) !== 0) {
        cells.push({ x: cx * cellSize, y: cy * cellSize });
      }
    }
  }
  return cells;
}

/**
 * Tous les obstacles en UN SEUL objet Pixi — jamais un par cellule (§4.3) :
 * ~506 cellules bloquees sur cette carte, et le terrain est statique, donc
 * le construire une fois suffit. Meme discipline que `mapBorder` juste
 * au-dessus : on accumule les rectangles, puis un SEUL `.fill()`/`.stroke()`
 * les peint tous d'un coup.
 *
 * Remplissage uni plutot qu'un sprite de l'atlas Tiny Swords : ce dernier
 * n'a pas de tuile "rocher" derivee par `tools/build_monster_atlas.py`
 * (seuls les monstres le sont), et en fabriquer une pour ce seul usage
 * aurait ajoute un chargement reseau asynchrone (et son echec possible, cf.
 * la doc de `Stage.init` sur l'atlas de la horde) pour un gain visuel
 * marginal sur un aplat dans la meme palette terreuse que le cadre.
 */
function mapObstacles(mask: Uint8Array, cols: number, rows: number, cellSize: number): Graphics {
  const g = new Graphics();
  for (const cell of obstacleCells(mask, cols, rows, cellSize)) {
    g.rect(cell.x, cell.y, cellSize, cellSize);
  }
  g.fill(OBSTACLE_FILL).stroke({ color: OBSTACLE_STROKE, width: 1, alpha: 0.5 });
  return g;
}

/**
 * Contenu du HUD (§4.6 : un HUD, pas des logs), separe de son ecriture DOM
 * dans `main.ts` — cette fonction est PURE, sans Pixi ni `document`, pour
 * rester testable sans navigateur : c'est elle qui porte « le HUD reflete
 * les points de vie et l'experience du snapshot ».
 */
export interface HudInfo {
  hp: number;
  xp: number;
  /**
   * Part du niveau en cours, dans `[0, 1]` : `xp` sur le seuil que `Room`
   * applique (`LEVEL_XP_BASE x niveau x joueurs`, `#xpToNextLevel`).
   */
  xpRatio: number;
  /** Le seuil du niveau en cours : l'XP a atteindre (meme formule que `Room`). */
  xpNeeded: number;
  level: number;
  timer: string;
  /** Vrai pendant le gel de montee de niveau (tache 24) — voir `GameClient.isFrozen`. */
  frozen: boolean;
}

/**
 * `level`, `hordeTick` et `frozen` ne sont pas dans `RenderState` : le niveau
 * vient de `GameClient.level` (derive des `LEVEL_UP`, pas de l'xp seul — voir
 * sa doc), le tick de `GameClient.hordeTick`, et `frozen` de
 * `GameClient.isFrozen` (tache 24). Le HUD lit donc les trois directement sur
 * le client, en plus de `state`. `frozen` vaut `false` par defaut : aucun
 * appelant existant (avant la tache 24) n'a a fournir cet argument.
 */
export function hudInfo(
  state: RenderState,
  level: number,
  hordeTick: number,
  frozen = false,
): HudInfo {
  const me = state.players.find((p) => p.id === state.localId);
  return {
    hp: me?.hp ?? 0,
    xp: state.xp,
    xpRatio: Math.min(
      1,
      Math.max(0, state.xp / (LEVEL_XP_BASE * level * Math.max(1, state.players.length))),
    ),
    xpNeeded: LEVEL_XP_BASE * level * Math.max(1, state.players.length),
    level,
    timer: formatTimer(hordeTick),
    frozen,
  };
}

/** `ticks` -> `m:ss`, a `TICK_HZ` pas par seconde. Utilise par le HUD et par `formatSummary`. */
export function formatTimer(ticks: number): string {
  const totalSeconds = Math.max(0, Math.floor(ticks / TICK_HZ));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Contenu de l'ecran de bilan, tel que porte par `RUN_OVER` (§7) — pure, meme raison que `hudInfo`. */
export interface SummaryInfo {
  time: string;
  level: number;
  kills: number;
}

export function formatSummary(summary: RunOverSummary): SummaryInfo {
  return {
    time: formatTimer(summary.survivedTicks),
    level: summary.level,
    kills: summary.kills,
  };
}
