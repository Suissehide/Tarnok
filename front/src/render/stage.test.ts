// @vitest-environment jsdom
import { ORB_PICKUP_RADIUS, TICK_HZ, ZONE_RADIUS } from '@shared/constants';
import { Container } from 'pixi.js';
import { beforeAll, describe, expect, it } from 'vitest';

import { HitFlashes, ReactionFlashes, type RenderState } from '../net/client';
import {
  cameraShake,
  formatSummary,
  formatTimer,
  hudInfo,
  obstacleCells,
  SHAKE_BLAST_PX,
  SHAKE_MS,
  SHAKE_REACTION_PX,
  SHAKE_WINDOW_MS,
  Stage,
} from './stage';

/**
 * `hudInfo`/`formatSummary`/`formatTimer` sont des fonctions PURES, sans Pixi
 * ni `document` — voir leur doc dans `stage.ts`. C'est ce qui les rend
 * testables sans navigateur : c'est ici — et seulement ici — que « le HUD
 * reflete les pv et l'xp du snapshot » et « le bilan affiche les chiffres
 * portes par RUN_OVER » peuvent s'asserter.
 *
 * Depuis la tache 9 bis, `Stage.composeWorld` s'y ajoute : voir le dernier
 * bloc, et la raison pour laquelle ce fichier tourne sous jsdom.
 */
describe('hudInfo — le HUD reflete les pv et l xp du snapshot', () => {
  it('lit les pv du joueur local, pas d un autre joueur', () => {
    const state: RenderState = {
      localId: 2,
      xp: 0,
      synergy: 0,
      players: [
        { id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
        { id: 2, x: 0, y: 0, hp: 37, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
      ],
    };

    expect(hudInfo(state, 1, 0).hp).toBe(37);
  });

  it("reprend l'xp d'equipe telle que portee par RenderState.xp", () => {
    const state: RenderState = {
      localId: 1,
      xp: 654,
      synergy: 0,
      players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS }],
    };

    expect(hudInfo(state, 1, 0).xp).toBe(654);
  });

  it('reprend le niveau tel que fourni par l appelant (GameClient.level), pas derive de l etat', () => {
    const state: RenderState = {
      localId: 1,
      xp: 0,
      synergy: 0,
      players: [{ id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS }],
    };

    expect(hudInfo(state, 5, 0).level).toBe(5);
  });

  it('rend hp=0 quand le joueur local est absent de RenderState.players (pas encore de WELCOME)', () => {
    const state: RenderState = { localId: null, xp: 0, synergy: 0, players: [] };

    expect(hudInfo(state, 1, 0).hp).toBe(0);
  });

  it(
    "reprend l'indicateur de gel tel que fourni par l appelant (GameClient.isFrozen), " +
      'pas derive de l etat (tache 24) — et vaut faux par defaut',
    () => {
      const state: RenderState = {
        localId: 1,
        xp: 0,
        synergy: 0,
        players: [
          { id: 1, x: 0, y: 0, hp: 100, aimX: 0, aimY: 0, pickupRadius: ORB_PICKUP_RADIUS },
        ],
      };

      expect(hudInfo(state, 1, 0, true).frozen).toBe(true);
      expect(hudInfo(state, 1, 0, false).frozen).toBe(false);
      expect(hudInfo(state, 1, 0).frozen).toBe(false);
    },
  );
});

describe('formatTimer — ticks -> m:ss, a TICK_HZ pas par seconde', () => {
  it('formate zero tick', () => {
    expect(formatTimer(0)).toBe('0:00');
  });

  it('formate moins d une minute avec le zero de tete', () => {
    expect(formatTimer(9 * TICK_HZ)).toBe('0:09');
  });

  it('formate plusieurs minutes', () => {
    // 2 min 5 s = 125 s, a TICK_HZ pas par seconde.
    expect(formatTimer(125 * TICK_HZ)).toBe('2:05');
  });
});

describe('formatSummary — le bilan affiche les chiffres portes par RUN_OVER', () => {
  it('reprend survivedTicks/level/kills du message, sans les permuter', () => {
    const info = formatSummary({ survivedTicks: 90 * TICK_HZ, level: 6, kills: 213 });

    expect(info).toEqual({ time: '1:30', level: 6, kills: 213 });
  });
});

/**
 * `obstacleCells` est PURE (voir sa doc dans `stage.ts`) : c'est elle qui
 * porte « le rendu consulte le meme masque que le champ de flux » (tache
 * 28). `mapObstacles` (la construction Pixi elle-meme) n'est en revanche pas
 * testable ici, meme raison que `Stage` — pas de canevas sous `vitest`.
 */
describe('obstacleCells — geometrie des cellules bloquees, pour le dessin des obstacles (tache 28)', () => {
  it('rend le coin haut-gauche de chaque cellule bloquee, a la bonne position (pas de transposition ligne/colonne)', () => {
    // Mutation testee : indexer `mask` par `cx * rows + cy` au lieu de
    // `cy * cols + cx` (confusion ligne/colonne facile a commettre) deplace
    // les rectangles rendus sur une carte non carree comme celle-ci
    // (cols=3, rows=2) — un damier carre ne le detecterait pas.
    const cols = 3;
    const rows = 2;
    const cellSize = 10;
    const mask = new Uint8Array(cols * rows);
    mask[2] = 1; // (cx=2, cy=0)
    mask[3] = 1; // (cx=0, cy=1)
    mask[5] = 1; // (cx=2, cy=1) — derniere cellule : verifie que la derniere ligne est bien parcourue.

    const cells = obstacleCells(mask, cols, rows, cellSize);

    expect(cells).toEqual([
      { x: 20, y: 0 },
      { x: 0, y: 10 },
      { x: 20, y: 10 },
    ]);
  });

  it('ne rend aucune cellule pour un masque entierement libre', () => {
    // Mutation testee : une garde inversee (`=== 0` au lieu de `!== 0`, ou un
    // `?? 1` au lieu de `?? 0`) ferait apparaitre des rochers sur une carte
    // sans le moindre obstacle.
    const mask = new Uint8Array(6);

    expect(obstacleCells(mask, 3, 2, 10)).toEqual([]);
  });
});

/**
 * Tache 9 bis : **la composition de la scene, gardee pour la premiere fois.**
 *
 * `Stage.init` construit une `Application` Pixi — un contexte WebGL qu'aucun
 * environnement de test ne fournit — et c'est ce qui mettait TOUT `init` hors
 * de portee : retirer un calque entier (« les zones ni attachees ni
 * chargees ») laissait la suite verte a 170 tests. `composeWorld` est la part
 * de `init` qui ne touche pas au GPU, et elle s'execute ici.
 *
 * Le contexte 2D est bouchonne : jsdom n'en fournit pas (il faudrait le paquet
 * `canvas`), et les textures des calques sont procedurales. On ne verifie pas
 * ce que le degrade dessine — c'est du pixel, invisible a un test — mais
 * qu'une texture a bien ete POSEE sur chaque calque, ce qui est exactement la
 * moitie « ni chargee » de la mutation.
 */
function stubCanvas2d(): void {
  // Chaque methode ne fait rien EXPRES : le bouchon existe pour que
  // `makeZoneAtlas` & consorts aillent jusqu'a leur `Texture.from`, pas pour
  // reproduire un rendu 2D.
  const noop = (): void => undefined;
  const gradient = { addColorStop: noop };
  const context = {
    createRadialGradient: () => gradient,
    // Tache 12 : l'atlas des projectiles et la texture de trainee dessinent
    // des chemins et un degrade lineaire, la ou zones/orbes/flashs se
    // contentaient d'un disque a degrade radial.
    createLinearGradient: () => gradient,
    fillStyle: '' as unknown,
    globalCompositeOperation: '' as unknown,
    save: noop,
    restore: noop,
    translate: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    quadraticCurveTo: noop,
    arc: noop,
    // L'orbe en gemme pose une ombre en ellipse sous sa pointe.
    ellipse: noop,
    fill: noop,
    fillRect: noop,
    // Tache 13 : les fleches du couloir de charge sont un chevron TRACE, pas
    // un aplat — le premier trait du jeu.
    strokeStyle: '' as unknown,
    lineWidth: 0 as unknown,
    lineCap: '' as unknown,
    lineJoin: '' as unknown,
    stroke: noop,
    // Étape 8 : l'atlas des trainees peint chaque profil sur son propre
    // canevas avant de le recopier dans sa bande — `softenAcross` travaille en
    // `destination-in`, qui ne connait pas les bandes (voir `makeStreakAtlas`).
    drawImage: noop,
  };
  const canvas = HTMLCanvasElement.prototype as unknown as { getContext: () => unknown };
  canvas.getContext = (): unknown => context;
}

/**
 * La secousse de camera (etape 8) : une fonction PURE des flashs vivants, donc
 * testable sans `Application` Pixi — c'est tout l'interet de l'avoir sortie de
 * `Stage`. Ce qu'elle garde : la hierarchie du §6.6, l'extinction, et le fait
 * qu'un coup ORDINAIRE ne secoue rien.
 */
describe('cameraShake — ce qui se sent, et ce qui ne se sent pas', () => {
  function avecImpact(radius: number, ageMs: number): { x: number; y: number } {
    const hits = new HitFlashes(8);
    hits.spawn(0, 0, 0xffffff, radius, 10, 0);
    return cameraShake(hits, new ReactionFlashes(8), ageMs);
  }

  function avecReaction(ageMs: number): { x: number; y: number } {
    const reactions = new ReactionFlashes(8);
    reactions.spawn(0, 0, 0, false, 0);
    return cameraShake(new HitFlashes(8), reactions, ageMs);
  }

  /** Un tir de souffle toutes les `pasMs` millisecondes, comme sur un boss. */
  function martelage(pasMs: number, jusquaMs: number): HitFlashes {
    const hits = new HitFlashes(128);
    for (let t = 0; t <= jusquaMs; t += pasMs) {
      hits.spawn(0, 0, 0xffffff, ZONE_RADIUS, 10, t);
    }
    return hits;
  }

  const norme = (v: { x: number; y: number }): number => Math.hypot(v.x, v.y);

  it('ne secoue RIEN sur un coup sans souffle', () => {
    // Seize armes sur dix-sept : sans ce test, l'ecran tremblerait a chaque
    // projectile qui touche, des dizaines de fois par seconde.
    expect(avecImpact(0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('secoue sur une explosion, et s eteint avec elle', () => {
    expect(norme(avecImpact(ZONE_RADIUS, 0))).toBeGreaterThan(0);
    expect(norme(avecImpact(ZONE_RADIUS, SHAKE_MS / 2))).toBeLessThan(
      norme(avecImpact(ZONE_RADIUS, 0)),
    );
    expect(avecImpact(ZONE_RADIUS, SHAKE_MS)).toEqual({ x: 0, y: 0 });
    expect(avecImpact(ZONE_RADIUS, SHAKE_MS * 3)).toEqual({ x: 0, y: 0 });
  });

  it('secoue PLUS FORT pour une reaction que pour une explosion — le §6.6', () => {
    expect(SHAKE_REACTION_PX).toBeGreaterThan(SHAKE_BLAST_PX);
    expect(norme(avecReaction(0))).toBeGreaterThan(norme(avecImpact(ZONE_RADIUS, 0)));
  });

  it('ne depasse jamais l amplitude annoncee', () => {
    for (let age = 0; age < SHAKE_MS; age += 7) {
      expect(Math.abs(avecReaction(age).x)).toBeLessThanOrEqual(SHAKE_REACTION_PX);
      expect(Math.abs(avecReaction(age).y)).toBeLessThanOrEqual(SHAKE_REACTION_PX);
    }
  });

  it('ne suit pas une diagonale : les deux axes ne battent pas ensemble', () => {
    // A frequence egale, le decalage glisserait au lieu de cogner.
    const ratios = new Set<number>();
    for (let age = 10; age < SHAKE_MS; age += 20) {
      const v = avecReaction(age);
      ratios.add(Math.round((v.x / (v.y || 1)) * 100));
    }
    expect(ratios.size).toBeGreaterThan(3);
  });

  /**
   * Étape 8, sur retour de jeu : *« trop de vibration de l'ecran si je tape un
   * boss, ca enclenche les effets en boucle »*.
   */
  it('ne tremble JAMAIS en continu, meme sous un martelage d arme de souffle', () => {
    // Dix coups par seconde pendant deux secondes, comme sur un boss.
    const hits = martelage(100, 2000);
    const reactions = new ReactionFlashes(8);

    const PAS = 10;
    let immobiles = 0;
    let total = 0;
    let calmeCourant = 0;
    let calmeMax = 0;
    for (let t = 0; t <= 2000; t += PAS) {
      const v = cameraShake(hits, reactions, t);
      total++;
      if (Math.hypot(v.x, v.y) === 0) {
        immobiles++;
        calmeCourant += PAS;
        calmeMax = Math.max(calmeMax, calmeCourant);
      } else {
        calmeCourant = 0;
      }
    }
    // L'ecran passe la MAJORITE du temps immobile…
    expect(immobiles / total).toBeGreaterThan(0.5);
    // …et surtout il RETOMBE : chaque fenetre contient un silence d'au moins
    // `SHAKE_WINDOW_MS - SHAKE_MS`. C'est la moitie qui compte — une secousse
    // qui ne s'arrete jamais plus de 20 ms serait « immobile la moitie du
    // temps » elle aussi, et ce serait exactement le defaut signale.
    expect(calmeMax).toBeGreaterThanOrEqual(SHAKE_WINDOW_MS - SHAKE_MS - PAS);
  });

  it('ne RELANCE pas une secousse en cours quand un second coup tombe dedans', () => {
    // Deux coups dans la meme fenetre : le second ne doit rien rallumer.
    const hits = new HitFlashes(8);
    hits.spawn(0, 0, 0xffffff, ZONE_RADIUS, 10, 0);
    hits.spawn(0, 0, 0xffffff, ZONE_RADIUS, 10, SHAKE_MS - 10);
    const seul = avecImpact(ZONE_RADIUS, SHAKE_MS - 5);
    const deux = cameraShake(hits, new ReactionFlashes(8), SHAKE_MS - 5);
    expect(deux).toEqual(seul);
    // Et a la fin de la fenetre, tout est retombe malgre le second coup.
    expect(cameraShake(hits, new ReactionFlashes(8), SHAKE_MS + 1)).toEqual({ x: 0, y: 0 });
  });

  it('rend zero quand aucun flash ne vit', () => {
    expect(cameraShake(new HitFlashes(8), new ReactionFlashes(8), 1000)).toEqual({ x: 0, y: 0 });
  });
});

describe('Stage.composeWorld — chaque calque attache ET charge', () => {
  beforeAll(stubCanvas2d);

  it('attache les onze calques du monde', () => {
    const world = new Container();
    new Stage().composeWorld(world);

    // Zones, COULOIR DE CHARGE (etape 6a, tache 5 bis), VERBES (etape 8),
    // anneaux de marque (tache 13), orbes, horde, projectiles, CHAINE DE
    // FOUDRE (etape 5b, tache 3), flashs d'impact, flashs de reaction, BARRE DU
    // BOSS (tache 5), et les COMPORTEMENTS (kamikaze, chaman) : douze, et un
    // calque oublie est un calque invisible.
    expect(world.children).toHaveLength(12);
  });

  it('charge la texture de chaque calque procedural, et laisse l atlas de la horde a `init`', () => {
    const stage = new Stage();
    stage.composeWorld(new Container());

    // Dans l'ordre d'affichage : zones, couloir de charge, verbes, comportements, anneaux,
    // orbes, HORDE, projectiles, chaine de Foudre, flashs d'impact, flashs de
    // reaction, barre du boss. Seule la horde reste `false` — son atlas se
    // fetch, et `init` le charge a part avec son propre rattrapage d'echec.
    expect(stage.layersLoaded).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      false,
      true,
      true,
      true,
      true,
      true,
    ]);
  });

  it('ne charge rien tant que le monde n a pas ete compose', () => {
    // La moitie basse de la mutation : sans elle, un `layersLoaded` qui
    // rendrait `true` partout passerait le test precedent sans rien garder.
    expect(new Stage().layersLoaded).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});
