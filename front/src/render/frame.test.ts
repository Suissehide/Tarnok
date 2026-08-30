import { MAX_ENTITIES, PROJECTILE_CAPACITY } from '@shared/constants';
import { Horde } from '@shared/horde';
import { Projectiles } from '@shared/projectiles';
import { ZoneField } from '@shared/zones';
import { describe, expect, it } from 'vitest';

import { DerivedOrbs, HitFlashes, ReactionFlashes, type RenderState } from '../net/client';
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
  drawImpactFlashes(...args: unknown[]): void {
    this.#record('flashs-impact', ...args);
  }
  drawReactionFlashes(...args: unknown[]): void {
    this.#record('flashs-reaction', ...args);
  }
  draw(...args: unknown[]): void {
    this.#record('joueurs', ...args);
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
  players: [{ id: 1, x: 10, y: 20, hp: 90, aimX: 1, aimY: 0 }],
};

class RecordingClient implements FrameClient {
  readonly zones = new ZoneField();
  readonly horde = new Horde(MAX_ENTITIES);
  readonly orbs = new DerivedOrbs(MAX_ENTITIES);
  readonly projectiles = new Projectiles(PROJECTILE_CAPACITY);
  readonly hitFlashes = new HitFlashes(8);
  readonly reactionFlashes = new ReactionFlashes(8);
  /**
   * Volontairement DIFFERENT de l'horloge murale passee a `composeFrame` : sans
   * cet ecart, passer `now` la ou le tick est attendu resterait indetectable.
   */
  readonly hordeTick = 137;
  readonly updates: { now: number; dt: number }[] = [];

  update(now: number, dt: number): RenderState {
    this.updates.push({ now, dt });
    return STATE;
  }
}

class RecordingScreens implements FrameScreens {
  hud: RenderState[] = [];
  drafts = 0;

  updateHud(state: RenderState): void {
    this.hud.push(state);
  }
  updateDraft(): void {
    this.drafts++;
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
    expect(stage.argsOf('zones')).toEqual([client.zones, client.hordeTick]);
  });

  /**
   * ⚠️ **Tache 13 : c'est ce calque qui porte desormais le piege du tick.**
   * Il lit la MEME horde que `drawHorde`, mais au tick de simulation — celui
   * qui fait expirer une marque. Passer `now` a la place laisserait des anneaux
   * allumes ou eteints au hasard, et l'ecart entre `NOW` et `hordeTick` dans ce
   * double est ce qui le rend visible.
   */
  it('dessine les anneaux de marque, avec la horde et le TICK de horde', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('marques')).toEqual([client.horde, client.hordeTick]);
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
    expect(stage.argsOf('horde')).toEqual([client.horde, NOW]);
  });

  it('dessine les orbes', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('orbes')).toEqual([client.orbs, NOW]);
  });

  it('dessine les projectiles', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('projectiles')).toEqual([client.projectiles]);
  });

  it('dessine les flashs d impact', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('flashs-impact')).toEqual([client.hitFlashes, NOW]);
  });

  it('dessine les flashs de reaction', () => {
    const { stage, client } = compose();
    expect(stage.argsOf('flashs-reaction')).toEqual([client.reactionFlashes, NOW]);
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
   * ⚠️ **L'ordre EST le §6.6**, pas une commodite : les zones au sol sont le
   * calque le plus bas, le flash de reaction passe devant tous les effets de
   * monde, et les carres des joueurs (avec la camera) viennent en dernier.
   */
  it('respecte la hierarchie de calques du §6.6', () => {
    const { stage } = compose();
    expect(stage.order).toEqual([
      'zones',
      'marques',
      'horde',
      'orbes',
      'projectiles',
      'flashs-impact',
      'flashs-reaction',
      'joueurs',
    ]);
  });
});
