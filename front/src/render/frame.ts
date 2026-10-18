import type { AbilityUsed } from '@shared/abilities';
import { type BossCharge, chargeWindsUpAt } from '@shared/boss';
import type { EnemyShot } from '@shared/enemy-shots';
import type { Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';
import type { ZoneField } from '@shared/zones';

import type {
  ActivePing,
  BlastFlash,
  BossVitals,
  ChainFlashes,
  DamageNumbers,
  DerivedOrbs,
  EventView,
  FrappeTrace,
  GuardTrace,
  HitFlashes,
  OndeTrace,
  OrbFlights,
  PickupTarget,
  ReactionFlashes,
  RenderState,
} from '../net/client';
import type { BeamAnchor } from './chain-renderer';

/**
 * Une image complete du jeu : ce qui est dessine, et dans quel ordre.
 *
 * ⚠️ **Pourquoi ce module existe.** `main.ts` fait ses recherches DOM et son
 * `await stage.init()` au NIVEAU MODULE : l'importer dans un test executerait
 * tout le demarrage, et construirait une `Application` Pixi qu'aucun
 * environnement de test ne sait instancier. Tout ce qui vit dans `main.ts` est
 * donc hors de portee de la suite, et des appels oublies y sont deja passes
 * inapercus.
 *
 * `composeFrame` n'instancie RIEN : elle recoit le client, la scene et les
 * deux ecrans HTML, et se contente d'appeler. C'est ce qui la rend testable
 * avec de simples doubles enregistreurs — voir `frame.test.ts`, ou chaque
 * calque a son assertion. `main.ts` ne garde que le demarrage et le cablage.
 */

/**
 * Ce que la boucle lit du client a chaque image.
 *
 * Une interface structurelle plutot que `GameClient` lui-meme : `GameClient`
 * la satisfait sans rien declarer, et le test peut en fabriquer un double sans
 * ouvrir de WebSocket.
 */
export interface FrameClient {
  update(now: number, dt: number): RenderState;
  readonly zones: ZoneField;
  /** Les verbes annonces, pour leur calque — voir `AbilityRenderer`. */
  readonly abilityEvents: readonly AbilityUsed[];
  readonly blastFlashes: readonly BlastFlash[];
  readonly shots: { readonly shots: readonly EnemyShot[] };
  readonly horde: Horde;
  readonly orbs: DerivedOrbs;
  /**
   * Les orbes capturees, en vol vers leur ramasseur — une
   * collection SEPAREE d'`orbs`, comme les flashs : ce que `PICKUPS` retire de
   * la reserve n'y est plus, et un vol lui survit le temps d'arriver.
   */
  readonly orbFlights: OrbFlights;
  readonly projectiles: Projectiles;
  readonly hitFlashes: HitFlashes;
  /** Les chiffres de degats — purement cosmetiques, comme les flashs. */
  readonly damageNumbers: DamageNumbers;
  readonly reactionFlashes: ReactionFlashes;
  /**
   * Flashs de chaine de Foudre — semes une fois par `GameClient#seedChainFlash`, jamais redérivés : voir
   * `ChainFlashes`.
   */
  readonly chainFlashes: ChainFlashes;
  /** Les ondes vivantes — voir `GameClient.ondes`. */
  readonly ondes: readonly OndeTrace[];
  /** Les impacts de frappe, en attente ou frappes — voir `GameClient.frappes`. */
  readonly frappes: readonly FrappeTrace[];
  /** Les homoncules vivants : leur aura suit l'invocateur — voir `GameClient.guards`. */
  readonly guards: readonly GuardTrace[];
  /**
   * Le tick de horde — **pas** l'horloge murale. C'est lui qui fait mourir les
   * zones et expirer les marques, avec le meme predicat que le serveur ; les
   * confondre est une mutation a part entiere, et le test la tue.
   */
  readonly hordeTick: number;
  /**
   * La vitesse du monde, dans `[0, 1]` : `0` pendant le gel du choix, une rampe
   * a la reprise, `1` sinon (`GameClient#movementScale`). L'ANIMATION de la
   * horde la suit, sinon le boss et les monstres marchent sur place pendant
   * le choix. Absente : `1`.
   */
  readonly motionScale?: number;
  /**
   * Le boss vivant, ou `null` — voir `GameClient.boss`. Il n'est pas dans
   * `RenderState` parce qu'il n'est ni predit ni interpole : c'est une donnee
   * d'en-tete de snapshot, lue telle quelle.
   */
  readonly boss: BossVitals | null;
  /**
   * La charge du boss en cours, ou `null` — voir `GameClient.bossCharge`.
   * Annoncee une fois, derivee ensuite : comme `boss`, elle n'est ni predite ni
   * interpolee, donc elle n'est pas dans `RenderState`.
   */
  readonly bossCharge: BossCharge | null;
  /** Les pings annonces, au plus un par joueur — voir `GameClient.pings`. */
  readonly pings: ReadonlyMap<number, ActivePing>;
  /**
   * L'horloge de ping — voir `GameClient#pingClock`. Comme `hordeTick`, SAUF
   * qu'elle n'avance pas pendant le gel de niveau : c'est elle, jamais
   * `hordeTick`, qui decide quels pings `drawPings` garde vivants.
   */
  readonly pingClock: number;
  /**
   * Le porteur de coffre, ou `null` — voir `GameClient.porteur`.
   * Optionnel : les doubles qui n'en ont pas passent `null`.
   */
  readonly porteur?: { x: number; y: number } | null;
  /**
   * L'evenement en cours (etape 14), ou `null` — voir `GameClient.event`.
   * Optionnel : les doubles qui n'en ont pas passent `null`.
   */
  readonly event?: EventView | null;
}

/**
 * Les calques de la scene. **`Stage` la satisfait structurellement**, sans
 * adaptateur : c'est la condition pour que retirer un appel d'ici fasse
 * rougir la suite au lieu de deplacer le probleme dans un cablage a part.
 */
export interface FrameStage {
  /** `tick` decide qui vit ; `timeMs`, l'horloge murale, n'anime que la silhouette. */
  drawZones(zones: ZoneField, tick: number, timeMs: number): void;
  /**
   * Le couloir de la charge du boss. Comme les zones,
   * il prend le TICK de simulation : c'est lui qui fait monter son opacite et
   * qui le fait disparaitre, au meme instant que le deplacement qu'il annonce.
   */
  drawBossCharge(charge: BossCharge | null, tick: number): void;
  drawAbilities(events: readonly AbilityUsed[], tick: number, timeMs: number): void;
  /** Les cercles des kamikazes et des chamans, et les explosions (horloge murale). */
  drawBehaviors(
    horde: Horde,
    blasts: readonly BlastFlash[],
    shots: readonly EnemyShot[],
    timeMs: number,
    event: EventView | null,
    players: readonly { x: number; y: number; hp: number }[],
  ): void;
  /**
   * Les anneaux de marque, sous les pieds des ennemis marques. Ils
   * lisent la horde comme `drawHorde`, mais au TICK de simulation : c'est lui
   * qui fait expirer une marque.
   */
  drawMarks(horde: Horde, tick: number, timeMs: number): void;
  /**
   * `heldEntityId` : l'entite dont le clip reste fige sur sa premiere image
   * — le boss pendant qu'il arme sa charge, `null` sinon.
   */
  drawHorde(horde: Horde, timeMs: number, heldEntityId: number | null): void;
  /**
   * Les orbes au sol, les orbes en vol, et les positions DESSINEES des joueurs :
   * une orbe capturee rejoint son ramasseur. C'est `RenderState` qui
   * porte ces positions, pas le client — donc `composeFrame` doit passer
   * l'etat qu'elle vient d'obtenir, jamais une autre lecture.
   */
  drawOrbs(
    orbs: DerivedOrbs,
    flights: OrbFlights,
    players: readonly PickupTarget[],
    timeMs: number,
  ): void;
  /**
   * Les ondes et les frappes, a l'horloge MURALE comme la chaine :
   * les degats sont deja arbitres, ce calque n'amortit qu'un dessin.
   */
  drawOndesFrappes(
    ondes: readonly OndeTrace[],
    frappes: readonly FrappeTrace[],
    nowMs: number,
    guards: readonly GuardTrace[],
    players: readonly BeamAnchor[],
  ): void;
  drawProjectiles(projectiles: Projectiles): void;
  /**
   * La polyligne de la chaine de Foudre. Prend l'HORLOGE MURALE, comme
   * `drawImpactFlashes` : le chemin est deja fige au moment de l'impact, ce
   * calque ne fait qu'amortir un flash — voir `ChainRenderer.draw`.
   */
  drawChain(flashes: ChainFlashes, nowMs: number, players: readonly BeamAnchor[]): void;
  drawImpactFlashes(flashes: HitFlashes, nowMs: number): void;
  drawReactionFlashes(flashes: ReactionFlashes, nowMs: number): void;
  /**
   * La secousse de camera, DERIVEE des memes flashs que les deux
   * calques ci-dessus — voir `Stage.shakeCamera`. Elle ne dessine rien : elle
   * deplace ce qui vient d'etre dessine.
   */
  shakeCamera(hits: HitFlashes, reactions: ReactionFlashes, nowMs: number): void;
  /**
   * La barre de vie du boss. Elle a besoin des DEUX : la
   * horde pour la position, le snapshot pour les PV — voir
   * `BossBarRenderer.draw`.
   */
  drawBossBar(horde: Horde, boss: BossVitals | null): void;
  /**
   * Les chiffres de degats, a l'horloge MURALE comme les flashs :
   * ils montent et s'effacent, ils n'arbitrent rien.
   */
  drawDamageNumbers(numbers: DamageNumbers, nowMs: number): void;
  /** Les carres des joueurs et la camera — voir `Stage.draw`. */
  draw(state: RenderState): void;
  /**
   * Les pings : marqueurs dans le monde, fleches en bord d'ecran pour
   * les pings ET les allies hors champ. Le TICK decide qui vit ; `players` sont
   * les positions DESSINEES, comme pour `drawOrbs`.
   */
  drawPings(
    pings: ReadonlyMap<number, ActivePing>,
    players: readonly { id: number; x: number; y: number }[],
    localId: number | null,
    tick: number,
    timeMs: number,
    porteur: { x: number; y: number } | null,
    event: EventView | null,
  ): void;
}

/**
 * Les deux ecrans HTML que l'image met a jour en plus de la scene Pixi : le
 * HUD et l'etalage de cartes. Ils vivent dans le DOM, pas dans le monde,
 * d'ou une interface separee de `FrameStage`.
 */
export interface FrameScreens {
  updateHud(state: RenderState): void;
  updateDraft(): void;
  /**
   * L'ecran du vote d'extraction.
   *
   * ⚠️ **Il passe par ICI et pas par `main.ts`**, pour qu'un test garde son
   * appel. Ce vote engage tout l'or d'une run ; un ecran qu'on oublierait
   * d'appeler laisserait la fenetre se fermer sans que personne n'ait pu
   * voter.
   *
   * Sans argument, comme `updateDraft` : l'ecran lit le client a chaque image,
   * y compris le tick dont il derive son chronometre.
   */
  updatePortal(): void;
}

/** L'horloge d'animation de la horde, par client : elle avance a `motionScale`. */
const clocks = new WeakMap<object, { t: number; last: number }>();

/**
 * Le temps d'animation de la horde : l'horloge murale, ralentie par la vitesse
 * du monde. Gele pendant le choix, il reprend avec la rampe — jamais un saut.
 */
export function hordeClock(client: Pick<FrameClient, 'motionScale'>, now: number): number {
  let c = clocks.get(client);
  if (!c) {
    c = { t: now, last: now };
    clocks.set(client, c);
  }
  c.t += Math.max(0, now - c.last) * (client.motionScale ?? 1);
  c.last = now;
  return c.t;
}

/**
 * Avance le client d'une image et dessine tout ce qui en depend.
 *
 * ⚠️ **L'ORDRE COMPTE.** Les zones au sol en premier (le calque le plus
 * bas), puis les anneaux de marque qui s'y posent, la chaine de Foudre juste
 * au-dessus des projectiles, le flash de reaction en dernier des effets de
 * monde, la barre de vie du boss par-dessus eux, puis les carres des joueurs
 * et la camera (`draw`). Le meme ordre que l'attache des calques dans
 * `Stage.composeWorld`.
 *
 * `now` est l'horloge MURALE (animations, flashs, chaine) et
 * `client.hordeTick` le tick de simulation (zones, marques, couloir de
 * charge) : les deux ne sont pas interchangeables. La horde ne recoit que
 * l'horloge murale ; la marque elementaire est dans `drawMarks`, au tick.
 */
export function composeFrame(
  client: FrameClient,
  stage: FrameStage,
  screens: FrameScreens,
  now: number,
  dt: number,
): RenderState {
  const state = client.update(now, dt);
  stage.drawZones(client.zones, client.hordeTick, now);
  // Juste au-dessus des zones et SOUS tout le reste : c'est un aplat au sol, et
  // le boss doit passer par-dessus le couloir qu'il traverse.
  stage.drawBossCharge(client.bossCharge, client.hordeTick);
  stage.drawAbilities(client.abilityEvents, client.hordeTick, now);
  // Etape 14 : l'evenement au sol, avec les joueurs DESSINES (occupation des sceaux).
  stage.drawBehaviors(
    client.horde,
    client.blastFlashes,
    client.shots.shots,
    now,
    client.event ?? null,
    state.players,
  );
  stage.drawMarks(client.horde, client.hordeTick, now);
  // ⚠️ **L'animation d'attaque ne part qu'au DASH**. `stopped` vaut
  // deja 1 pendant le chargement — il sert au clip, pas au mouvement — donc
  // c'est ici, au moment de dessiner, que les deux temps se distinguent.
  const charge = client.bossCharge;
  const armant =
    charge !== null && chargeWindsUpAt(charge, client.hordeTick) ? charge.entityId : null;
  stage.drawHorde(client.horde, hordeClock(client, now), armant);
  stage.drawOrbs(client.orbs, client.orbFlights, state.players, now);
  // Sous les projectiles : une onde et un avertissement sont des nappes
  // au sol ; un tir qui les traverse doit rester lisible par-dessus.
  stage.drawOndesFrappes(client.ondes, client.frappes, now, client.guards, state.players);
  stage.drawProjectiles(client.projectiles);
  // Juste au-dessus des projectiles : une chaine relie des ennemis, elle doit
  // rester lisible par-dessus leurs sprites, comme un tir. `now`, pas
  // `hordeTick` : c'est un flash cosmetique. Les joueurs DESSINES : un
  // faisceau reste accroche a son tireur.
  stage.drawChain(client.chainFlashes, now, state.players);
  stage.drawImpactFlashes(client.hitFlashes, now);
  stage.drawReactionFlashes(client.reactionFlashes, now);
  // Au-dessus de tous les effets de monde : c'est une LECTURE, et une lecture
  // qu'un flash ne doit pas masquer au moment ou elle compte le plus.
  stage.drawBossBar(client.horde, client.boss);
  // Au-dessus de tout ce qui precede : un chiffre est une LECTURE, et rien ne
  // doit la masquer — voir l'ordre des calques dans `Stage`.
  stage.drawDamageNumbers(client.damageNumbers, now);
  screens.updateHud(state);
  screens.updateDraft();
  screens.updatePortal();
  stage.draw(state);
  // ⚠️ **APRES `draw`, qui recentre la camera** : les fleches de bord se
  // calculent en coordonnees ecran, avec le cadrage de CETTE image.
  //
  // ⚠️ **`pingClock`, PAS `hordeTick`** : les zones et
  // les marques expirent au tick de horde meme pendant le gel, mais un ping
  // ne doit pas s'effacer pendant que l'equipe choisit ses cartes — voir
  // `GameClient#pingClock`.
  stage.drawPings(
    client.pings,
    state.players,
    state.localId,
    client.pingClock,
    now,
    client.porteur ?? null,
    client.event ?? null,
  );
  // ⚠️ **APRES `draw`, qui recentre la camera sur le joueur** : la secousse est
  // un decalage par-dessus le cadrage, pas un cadrage concurrent.
  stage.shakeCamera(client.hitFlashes, client.reactionFlashes, now);
  return state;
}
