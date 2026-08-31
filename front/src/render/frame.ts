import type { Horde } from '@shared/horde';
import type { Projectiles } from '@shared/projectiles';
import type { ZoneField } from '@shared/zones';

import type {
  BossVitals,
  DerivedOrbs,
  HitFlashes,
  OrbFlights,
  PickupTarget,
  ReactionFlashes,
  RenderState,
} from '../net/client';

/**
 * Une image complete du jeu : ce qui est dessine, et dans quel ordre.
 *
 * ⚠️ **Ce module existe parce que la meme dette a mordu trois fois** (tache
 * 9 bis de l'etape 5a). `main.ts` fait ses recherches DOM et son
 * `await stage.init()` au NIVEAU MODULE : l'importer dans un test executerait
 * tout le demarrage, et construirait une `Application` Pixi qu'aucun
 * environnement de test ne sait instancier. Tout ce qui vivait dans `main.ts`
 * etait donc hors de portee de la suite — et l'est reste jusqu'a ce qu'une
 * mutation le montre :
 *
 * | Etape | Ce qui n'etait garde par rien | Tests verts a la decouverte |
 * | --- | --- | --- |
 * | 3 | le gel de niveau cote client | 76 |
 * | 4 | `draftScreen.update()` dans la boucle de rendu | 117 |
 * | 5a | `drawZones`, `drawReactionFlashes`, `paintSynergy` | 170 |
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
  readonly horde: Horde;
  readonly orbs: DerivedOrbs;
  /**
   * Les orbes capturees, en vol vers leur ramasseur (tache 20) — une
   * collection SEPAREE d'`orbs`, comme les flashs : ce que `PICKUPS` retire de
   * la reserve n'y est plus, et un vol lui survit le temps d'arriver.
   */
  readonly orbFlights: OrbFlights;
  readonly projectiles: Projectiles;
  readonly hitFlashes: HitFlashes;
  readonly reactionFlashes: ReactionFlashes;
  /**
   * Le tick de horde — **pas** l'horloge murale. C'est lui qui fait mourir les
   * zones et expirer les marques, avec le meme predicat que le serveur ; les
   * confondre est une mutation a part entiere, et le test la tue.
   */
  readonly hordeTick: number;
  /**
   * Le boss vivant, ou `null` — voir `GameClient.boss`. Il n'est pas dans
   * `RenderState` parce qu'il n'est ni predit ni interpole : c'est une donnee
   * d'en-tete de snapshot, lue telle quelle.
   */
  readonly boss: BossVitals | null;
}

/**
 * Les calques de la scene. **`Stage` la satisfait structurellement**, sans
 * adaptateur : c'est la condition pour que retirer un appel d'ici fasse
 * rougir la suite au lieu de deplacer le probleme dans un cablage a part.
 */
export interface FrameStage {
  drawZones(zones: ZoneField, tick: number): void;
  /**
   * Les anneaux de marque, sous les pieds des ennemis marques (tache 13). Ils
   * lisent la horde comme `drawHorde`, mais au TICK de simulation : c'est lui
   * qui fait expirer une marque.
   */
  drawMarks(horde: Horde, tick: number): void;
  drawHorde(horde: Horde, timeMs: number): void;
  /**
   * Les orbes au sol, les orbes en vol, et les positions DESSINEES des joueurs :
   * une orbe capturee rejoint son ramasseur (tache 20). C'est `RenderState` qui
   * porte ces positions, pas le client — donc `composeFrame` doit passer
   * l'etat qu'elle vient d'obtenir, jamais une autre lecture.
   */
  drawOrbs(
    orbs: DerivedOrbs,
    flights: OrbFlights,
    players: readonly PickupTarget[],
    timeMs: number,
  ): void;
  drawProjectiles(projectiles: Projectiles): void;
  drawImpactFlashes(flashes: HitFlashes, nowMs: number): void;
  drawReactionFlashes(flashes: ReactionFlashes, nowMs: number): void;
  /**
   * La barre de vie du boss (etape 6a, tache 5). Elle a besoin des DEUX : la
   * horde pour la position, le snapshot pour les PV — voir
   * `BossBarRenderer.draw`.
   */
  drawBossBar(horde: Horde, boss: BossVitals | null): void;
  /** Les carres des joueurs et la camera — voir `Stage.draw`. */
  draw(state: RenderState): void;
}

/**
 * Les deux ecrans HTML que l'image met a jour en plus de la scene Pixi : le
 * HUD (§4.6) et l'etalage de cartes (§7.2, etape 4). Ils vivent dans le DOM,
 * pas dans le monde, d'ou une interface separee de `FrameStage`.
 */
export interface FrameScreens {
  updateHud(state: RenderState): void;
  updateDraft(): void;
}

/**
 * Avance le client d'une image et dessine tout ce qui en depend.
 *
 * ⚠️ **L'ORDRE EST LE §6.6.** Les zones au sol en premier (le calque le plus
 * bas), puis les anneaux de marque qui s'y posent, le flash de reaction en
 * dernier des effets de monde, la barre de vie du boss par-dessus eux, puis les
 * carres des joueurs et la camera (`draw`). Le meme ordre que l'attache des
 * calques dans `Stage.composeWorld`.
 *
 * `now` est l'horloge MURALE (animations, flashs) et `client.hordeTick` le
 * tick de simulation (zones, marques) : les deux ne sont pas interchangeables.
 * Depuis la tache 13, la horde ne recoit plus que l'horloge murale — la marque
 * elementaire a quitte son sprite pour le calque `drawMarks`, qui prend le
 * tick.
 */
export function composeFrame(
  client: FrameClient,
  stage: FrameStage,
  screens: FrameScreens,
  now: number,
  dt: number,
): RenderState {
  const state = client.update(now, dt);
  stage.drawZones(client.zones, client.hordeTick);
  stage.drawMarks(client.horde, client.hordeTick);
  stage.drawHorde(client.horde, now);
  stage.drawOrbs(client.orbs, client.orbFlights, state.players, now);
  stage.drawProjectiles(client.projectiles);
  stage.drawImpactFlashes(client.hitFlashes, now);
  stage.drawReactionFlashes(client.reactionFlashes, now);
  // Au-dessus de tous les effets de monde : c'est une LECTURE, et une lecture
  // qu'un flash ne doit pas masquer au moment ou elle compte le plus.
  stage.drawBossBar(client.horde, client.boss);
  screens.updateHud(state);
  screens.updateDraft();
  stage.draw(state);
  return state;
}
