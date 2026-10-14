import type { BossCharge } from '@shared/boss';
import { MAX_ENTITIES, ORB_PICKUP_RADIUS, PROJECTILE_CAPACITY } from '@shared/constants';
import { Horde } from '@shared/horde';
import { Projectiles } from '@shared/projectiles';
import { ZoneField } from '@shared/zones';
import { describe, expect, it } from 'vitest';

import {
  type BossVitals,
  ChainFlashes,
  DerivedOrbs,
  HitFlashes,
  OrbFlights,
  ReactionFlashes,
  type RenderState,
} from '../net/client';
import { composeFrame, type FrameClient, type FrameScreens, type FrameStage } from './frame';

/**
 * Tache 9 bis : **la premiere suite du depot qui atteigne la boucle de rendu.**
 *
 * Jusqu'ici elle vivait dans `main.ts`, module qui fait `await stage.init()` au
 * niveau module — donc jamais importable en test, donc jamais mute. Sept
 * mutations y survivaient a 170 tests verts. `composeFrame` n'instancie rien :
 * elle recoit des cibles, et ce double les enregistre.
 *
 * ⚠️ **Le double enregistre les ARGUMENTS, pas seulement le fait de l'appel.**
 * Une des sept mutations ne retire aucune ligne : elle passe l'horloge murale
 * la ou `drawHorde` attend le tick de horde. Un double qui compterait les
 * appels la laisserait vivre.
 */

/** Un appel de dessin tel que la scene l'a recu : son nom, et ses arguments. */
interface Call {
  layer: string;
  args: unknown[];
}

class RecordingStage implements FrameStage {
  readonly calls: Call[] = [];

  #record(layer: string, ...args: unknown[]): void {
    this.calls.push({ layer, args });
  }

  drawZones(...args: unknown[]): void {
    this.#record('zones', ...args);
  }
  drawBossCharge(...args: unknown[]): void {
    this.#record('couloir-boss', ...args);
  }
  drawAbilities(...args: unknown[]): void {
    this.#record('verbes', ...args);
  }
  drawBehaviors(...args: unknown[]): void {
    this.#record('comportements', ...args);
  }
  drawMarks(...args: unknown[]): void {
    this.#record('marques', ...args);
  }
  drawHorde(...args: unknown[]): void {
    this.#record('horde', ...args);
  }
  drawOrbs(...args: unknown[]): void {
    this.#record('orbes', ...args);
  }
  drawProjectiles(...args: unknown[]): void {
    this.#record('projectiles', ...args);
  }
  drawChain(...args: unknown[]): void {
    this.#record('chaine', ...args);
  }
  drawImpactFlashes(...args: unknown[]): void {
    this.#record('flashs-impact', ...args);
  }
  drawReactionFlashes(...args: unknown[]): void {
    this.#record('flashs-reaction', ...args);
  }
  drawBossBar(...args: unknown[]): void {
    this.#record('barre-boss', ...args);
  }
  draw(...args: unknown[]): void {
    this.#record('joueurs', ...args);
  }
  shakeCamera(...args: unknown[]): void {
    this.#record('secousse', ...args);
  }

  /** Les arguments du seul appel a `layer`, ou `null` si le calque n'a rien recu. */
  argsOf(layer: string): unknown[] | null {
    const hits = this.calls.filter((c) => c.layer === layer);
    expect(hits.length, `${layer} : ${hits.length} appel(s)`).toBeLessThanOrEqual(1);
    return hits[0]?.args ?? null;
  }

  get order(): string[] {
    return this.calls.map((c) => c.layer);
  }
}

/** Etat rendu par le double de client : reconnaissable, pour qu'on puisse l'identifier. */
const STATE: RenderState = {
  localId: 1,
  xp: 42,
  synergy: 7,
  players: [{ id: 1, x: 10, y: 20, hp: 90, aimX: 1, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS }],
};

class RecordingClient implements FrameClient {
  readonly zones = new ZoneField();
  readonly abilityEvents = [];
  readonly blastFlashes = [];
  readonly horde = new Horde(MAX_ENTITIES);
  readonly orbs = new DerivedOrbs(MAX_ENTITIES);
  readonly orbFlights = new OrbFlights(8);
  readonly projectiles = new Projectiles(PROJECTILE_CAPACITY);
  readonly hitFlashes = new HitFlashes(8);
  readonly reactionFlashes = new ReactionFlashes(8);
  readonly chainFlashes = new ChainFlashes(8);
  /**
   * Volontairement DIFFERENT de l'horloge murale passee a `composeFrame` : sans
   * cet ecart, passer `now` la ou le tick est attendu resterait indetectable.
   */
  readonly hordeTick = 137;
  /**
   * Un boss reconnaissable, et surtout DISTINCT de la horde : `drawBossBar`
   * recoit les deux, et les intervertir ou n'en passer qu'un doit se voir.
   */
  readonly boss: BossVitals | null = { id: 8193, hp: 4200, maxHp: 6000 };
  /**
   * Une charge reconnaissable (etape 6a, tache 5 bis). Ses ticks encadrent
   * `hordeTick` : le couloir est en plein chargement a l'image dessinee, donc un
   * `drawBossCharge` qui recevrait l'horloge murale a la place du tick ne
   * dessinerait rien du tout.
   */
  readonly bossCharge: BossCharge | null = {
    entityId: 8193,
    x: 1000,
    y: 2000,
    dirX: 1,
    dirY: 0,
    length: 900,
    width: 192,
    windupTick: 120,
    startTick: 150,
    endTick: 168,
  };
  readonly updates: { now: number; dt: number }[] = [];

  update(now: number, dt: number): RenderState {
    this.updates.push({ now, dt });
    return STATE;
  }
}

class RecordingScreens implements FrameScreens {
  hud: RenderState[] = [];
  drafts = 0;
  portals = 0;

  updateHud(state: RenderState): void {
    this.hud.push(state);
  }
  updateDraft(): void {
    this.drafts++;
  }
  updatePortal(): void {
    this.portals++;
  }
}

const NOW = 5_000.5;
const DT = 1 / 60;

function compose(): {
  stage: RecordingStage;
  client: RecordingClient;
  screens: RecordingScreens;
  state: RenderState;
} {
  const stage = new RecordingStage();
  const client = new RecordingClient();
  const screens = new RecordingScreens();
  const state = composeFrame(client, stage, screens, NOW, DT);
  return { stage, client, screens, state };
}

describe('composeFrame — chaque calque recoit son appel', () => {
  it('avance le client une fois, avec l horloge murale et le pas de temps', () => {
    const { client, state } = compose();
    expect(client.updates).toEqual([{ now: NOW, dt: DT }]);
    expect(state).toBe(STATE);
  });

  it('dessine les zones au sol, avec le TICK de horde', () => {
    const { stage, client } = compose();
    // Le tick decide qui vit ; `NOW` n'anime que la silhouette.
    expect(stage.argsOf('zones')).toEqual([client.zones, client.hordeTick, NOW]);
  });

  /**
   * ⚠️ **Tache 13 : c'est ce calque qui porte desormais le piege du tick.**
   * Il lit la MEME horde que `drawHorde`, mais au tick de simulation — celui
   * qui fait expirer une marque. Passer `now` a la place laisserait des anneaux
   * allumes ou eteints au hasard, et l'ecart entre `NOW` et `hordeTick` dans ce
   * double est ce qui le rend visible.
   */
  /**
   * ⚠️ **Le TICK, jamais l'horloge murale** (etape 6a, tache 5 bis) : c'est lui
   * qui fait monter l'opacite du couloir et qui le fait disparaitre, au meme
   * instant que le deplacement du boss qu'il annonce. `hordeTick` (137) tombe
   * dans le chargement de la charge du double ; `NOW` (5 000,5) est tres au-dela
   * de `endTick`, donc l'intervertir n'afficherait plus rien.
   */
  it('dessine le couloir de charge du boss, avec le TICK de horde', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('couloir-boss')).toEqual([client.bossCharge, client.hordeTick]);
  });

  it('dessine les anneaux de marque, avec la horde et le TICK de horde', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('marques')).toEqual([client.horde, client.hordeTick, NOW]);
  });

  /**
   * ⚠️ **La horde ne recoit plus le tick depuis la tache 13** : il ne servait
   * qu'a la teinte elementaire de son sprite, partie au sol. Un argument de
   * plus, que personne ne lirait, serait du code qui ment — et la moitie
   * « jamais l'horloge a la place du tick » de l'ancienne assertion vit
   * maintenant sur `drawMarks`, juste au-dessus.
   */
  it('dessine la horde avec la seule horloge murale', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('horde')).toEqual([client.horde, NOW, client.bossCharge?.entityId]);
  });

  /**
   * ⚠️ **L'animation d'attaque ne part qu'au DASH** (etape 6a, tache 13) —
   * *« lance pas l'animation d'attaque du boss avant qu'il dash, juste la frame
   * 1 »*. `stopped` vaut 1 pendant TOUTE la charge : il sert au clip, jamais au
   * mouvement, et il ne bouge pas. Les deux temps se distinguent donc ICI, dans
   * la boucle de rendu, au TICK de simulation — l'horloge murale ne saurait pas
   * dire ou en est le chargement.
   *
   * Les trois moities, parce que deux ne suffisent pas : pendant le chargement
   * c'est l'identite du boss, pendant la traversee c'est `null`, et sans charge
   * du tout c'est `null` aussi.
   */
  it("fige le clip du boss pendant qu'il arme, et le relache au dash", () => {
    const pendant = compose();
    expect(pendant.client.bossCharge?.windupTick).toBeLessThanOrEqual(pendant.client.hordeTick);
    expect(pendant.client.hordeTick).toBeLessThan(pendant.client.bossCharge?.startTick ?? 0);
    expect(pendant.stage.argsOf('horde')?.[2]).toBe(pendant.client.bossCharge?.entityId);

    const dash = compose();
    // Le meme decor, un tick plus tard que le depart : le boss traverse.
    const traverse = new RecordingClient();
    Object.defineProperty(traverse, 'hordeTick', {
      value: (traverse.bossCharge?.startTick ?? 0) + 1,
    });
    const scene = new RecordingStage();
    composeFrame(traverse, scene, new RecordingScreens(), NOW, DT);
    expect(scene.argsOf('horde')?.[2]).toBeNull();
    expect(dash.stage.argsOf('horde')).not.toBeNull();

    const sansBoss = new RecordingClient();
    Object.defineProperty(sansBoss, 'bossCharge', { value: null });
    const scene2 = new RecordingStage();
    composeFrame(sansBoss, scene2, new RecordingScreens(), NOW, DT);
    expect(scene2.argsOf('horde')?.[2]).toBeNull();
  });

  /**
   * ⚠️ **Les POSITIONS DE L'ETAT, pas une autre lecture** (tache 17) : c'est
   * vers le joueur DESSINE qu'une orbe capturee vole, et `RenderState.players`
   * est le seul endroit qui le porte — la position predite pour soi, interpolee
   * pour les autres. Passer autre chose ferait arriver l'orbe sur un joueur qui
   * n'est pas a l'ecran la ou on le croit.
   *
   * ⚠️ **Les DEUX collections** (tache 20) : les orbes au sol ET les orbes en
   * vol. Elles sont separees parce que `PICKUPS` ne commande que la premiere —
   * un calque qui n'en recevrait qu'une ferait disparaitre l'orbe a la capture
   * au lieu de la faire arriver.
   */
  it('dessine les orbes au sol ET en vol, avec les positions dessinees des joueurs', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('orbes')).toEqual([client.orbs, client.orbFlights, STATE.players, NOW]);
  });

  it('dessine les projectiles', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('projectiles')).toEqual([client.projectiles]);
  });

  /**
   * ⚠️ **Etape 5b, tache 3 : le piege de forme qui a mordu trois fois** (voir
   * le tableau en tete de ce fichier). L'appel passe par ICI, jamais par la
   * boucle de rendu de `main.ts` — sans ce test, retirer `stage.drawChain(...)`
   * de `composeFrame` laisserait la suite verte, exactement comme
   * `drawZones`/`drawReactionFlashes`/`paintSynergy` l'ont fait pendant 170
   * tests avant la tache 9 bis.
   *
   * ⚠️ **Depuis le tour de correction 1, `chainFlashes` ET l'HORLOGE MURALE**
   * — plus la horde, plus le tick de simulation. Le chemin est deja figé au
   * moment de l'impact (`GameClient#seedChainFlash`) : ce calque n'est plus
   * qu'un flash de plus, amorti comme `hitFlashes`/`reactionFlashes`.
   */
  it('dessine la chaine de Foudre, avec ses flashs et l horloge murale', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('chaine')).toEqual([client.chainFlashes, NOW]);
  });

  it('dessine les flashs d impact', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('flashs-impact')).toEqual([client.hitFlashes, NOW]);
  });

  it('dessine les flashs de reaction', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('flashs-reaction')).toEqual([client.reactionFlashes, NOW]);
  });

  /**
   * ⚠️ **Les DEUX arguments** (etape 6a, tache 5) : la horde porte la POSITION
   * du boss, le snapshot porte ses PV, et aucune des deux ne suffit — voir
   * `BossBarRenderer.draw`. Un calque qui ne recevrait que le boss ne saurait
   * pas ou le dessiner ; un calque qui ne recevrait que la horde n'aurait
   * aucune fraction a remplir.
   */
  it('dessine la barre de vie du boss, avec la horde ET le boss du snapshot', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('barre-boss')).toEqual([client.horde, client.boss]);
  });

  it('dessine les joueurs et recentre la camera, avec l etat rendu par le client', () => {
    const { stage } = compose();
    expect(stage.argsOf('joueurs')).toEqual([STATE]);
  });

  it('met a jour le HUD avec ce meme etat', () => {
    const { screens } = compose();
    expect(screens.hud).toEqual([STATE]);
  });

  /**
   * La dette de l'etape 4, soldee ici : `draftScreen.update()` etait dans la
   * boucle de rendu depuis 117 tests verts sans que rien ne l'appelle en test.
   */
  it("met a jour l'etalage de cartes", () => {
    const { screens } = compose();
    expect(screens.drafts).toBe(1);
  });

  /**
   * ⚠️ **La MEME dette, et c'est la quatrieme fois qu'on la paie d'avance**
   * (etape 6a, tache 10). L'ecran du vote d'extraction aurait pu vivre dans
   * `main.ts` a cote de son `el('portal')` : il y aurait ete invisible a toute
   * la suite, exactement comme `draftScreen.update()` l'a ete pendant 117
   * tests verts. Ce qui pend a ce fil-ci est le plus cher du jeu — vingt
   * secondes pour engager tout l'or d'une run — et un appel perdu laisserait
   * la fenetre se fermer sans que personne n'ait pu voter.
   *
   * ⚠️ **`toBe(1)`, pas `toBeGreaterThan(0)`** : appeler deux fois par image
   * reconstruirait la liste des votants deux fois par image pour rien, et ne
   * se verrait nulle part ailleurs.
   */
  it("met a jour l'ecran du vote d'extraction, exactement une fois", () => {
    const { screens } = compose();
    expect(screens.portals).toBe(1);
  });

  /**
   * ⚠️ **L'ordre EST le §6.6**, pas une commodite : les zones au sol sont le
   * calque le plus bas, le flash de reaction passe devant tous les effets de
   * monde, et les carres des joueurs (avec la camera) viennent en dernier.
   */
  it('dessine les verbes annonces, avec le TICK de horde', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('verbes')?.slice(0, 2)).toEqual([client.abilityEvents, client.hordeTick]);
  });

  it('respecte la hierarchie de calques du §6.6', () => {
    const { stage } = compose();
    expect(stage.order).toEqual([
      'zones',
      'couloir-boss',
      'verbes',
      'comportements',
      'marques',
      'horde',
      'orbes',
      'projectiles',
      'chaine',
      'flashs-impact',
      'flashs-reaction',
      'barre-boss',
      'joueurs',
      // La secousse ferme la marche : elle deplace ce que `joueurs` vient de
      // cadrer, donc elle ne peut pas le preceder (voir `Stage.shakeCamera`).
      'secousse',
    ]);
  });

  it('secoue la camera avec les MEMES flashs que les calques, et l horloge murale', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('secousse')).toEqual([client.hitFlashes, client.reactionFlashes, NOW]);
  });
});
