import { describe, expect, it } from 'vitest';

import { FLOWFIELD_CELL, FLOWFIELD_HZ, MAP_SIZE, TICK_HZ } from './constants';
import { FlowField } from './flowfield';
import { Horde } from './horde';
import { PlayerHistory } from './player-history';
import { FORMATION, type WaveOrder } from './waves';
import { applyObstacles, generateObstacles } from './worldmap';

const DT = 1 / TICK_HZ;
const STEPS = 600;
const PARTICIPANTS = 5; // le serveur, plus quatre clients
const ENTITIES = 1000;

/** Seuil de derive tolere, en pixels. Valeur de depart, a confirmer par la mesure. */
const DRIFT_LIMIT_PX = 2;

/**
 * Une instance de simulation : ce que fait le serveur, et ce que fait chaque
 * client. Le code est le meme des deux cotes — c'est tout le sujet.
 */
function makeParticipant(mapSeed: number): {
  horde: Horde;
  fields: FlowField[];
  history: PlayerHistory;
} {
  const horde = new Horde(4000);
  const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
  const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
  const fields = Array.from({ length: 4 }, () => {
    const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    applyObstacles(f, mask);
    return f;
  });
  return { horde, fields, history: new PlayerHistory() };
}

type Participant = ReturnType<typeof makeParticipant>;

/** Cumule les deux mesures de divergence sur la duree d'un test. */
interface DriftStats {
  maxDrift: number;
  identityMismatches: number;
}

/**
 * Fait avancer toutes les simulations de `fromTick` (inclus) a `toTick`
 * (exclu), en accumulant dans `stats` la derive maximale et le nombre de
 * mesappariements d'identite observes.
 *
 * Factorise la boucle commune aux deux tests : elle seule sait comment
 * nourrir l'historique de joueurs, recalculer les champs a la cadence de
 * `FLOWFIELD_HZ` a partir des positions retardees, et faire avancer chaque
 * horde d'un pas.
 */
function advance(
  parts: readonly Participant[],
  fromTick: number,
  toTick: number,
  stats: DriftStats,
): void {
  const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
  const reference = parts[0];
  if (!reference) {
    throw new Error('aucun participant');
  }

  for (let tick = fromTick; tick < toTick; tick++) {
    // Les joueurs bougent : un champ fige ne prouverait rien.
    const xs = [0, 1, 2, 3].map((p) => 3000 + Math.cos(tick * 0.02 + p) * 1500);
    const ys = [0, 1, 2, 3].map((p) => 3000 + Math.sin(tick * 0.02 + p) * 1500);

    for (const p of parts) {
      p.history.record(tick, xs, ys);

      if (tick % stepsPerField === 0) {
        // Les positions du tick retarde, pas celles du tick courant.
        const seen = p.history.delayed(tick);
        if (seen) {
          for (let f = 0; f < 4; f++) {
            p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
          }
          p.horde.retarget(seen.x, seen.y);
        }
      }

      p.horde.step(DT, p.fields);
    }

    // 1. L'ensemble des identites doit etre STRICTEMENT egal.
    for (const p of parts.slice(1)) {
      expect(p.horde.count).toBe(reference.horde.count);
    }

    // 2. Comparer position et identite par indice n'a de sens que si
    // l'indice designe la meme entite chez tous les participants. Rien ne le
    // garantit a priori : deux participants qui compacteraient differemment
    // apres une mort auraient le meme `count` mais pas les memes entites aux
    // memes indices, et la comparaison de position deviendrait muette.
    for (const p of parts.slice(1)) {
      for (let i = 0; i < reference.horde.count; i++) {
        const drift = Math.hypot(
          (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
          (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
        );
        if (drift > stats.maxDrift) {
          stats.maxDrift = drift;
        }

        if (p.horde.entityIdAt(i) !== reference.horde.entityIdAt(i)) {
          stats.identityMismatches++;
        }
      }
    }
  }
}

describe("le livrable de l'etape 2", () => {
  it('fait converger 1 000 ennemis identiquement sur cinq simulations', () => {
    const mapSeed = 0xc0ff_ee12;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };
    for (const p of parts) {
      p.horde.spawn(order);
    }

    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };
    advance(parts, 0, STEPS, stats);

    // Le chiffre est affiche pour etre lisible plutot que cache : c'est lui qui
    // permettra de confirmer ou d'ajuster le seuil (§12 de la spec). Vitest 4
    // n'imprime les `console.log` que pour les tests en echec : ecrire
    // directement sur le flux du process contourne cette interception.
    process.stdout.write(
      `derive maximale observee : ${stats.maxDrift.toFixed(3)} px sur ${STEPS} pas\n`,
    );

    expect(stats.identityMismatches).toBe(0);
    expect(stats.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('reste identique quand une seconde vague apparait en cours de partie', () => {
    // Le premier test ne couvre que `spawn` sur une horde vide. En vrai, le
    // serveur emet une vague toutes les six secondes environ : `spawn`
    // s'exerce aussi sur une horde deja peuplee, avec la comptabilite de
    // capacite que ca implique. C'est ce cas que ce test verifie, plutot que
    // de dupliquer la premiere assertion sans avancer la simulation.
    const mapSeed = 0x7a11_0c0d;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));

    const firstWave: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: 600,
    };
    for (const p of parts) {
      p.horde.spawn(firstWave);
    }

    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };
    const FIRST_LEG = 100;
    const SECOND_LEG = 200;

    advance(parts, 0, FIRST_LEG, stats);

    const secondWave: WaveOrder = {
      waveId: 2,
      spawnTick: FIRST_LEG,
      seed: 0x1234_5678,
      archetype: 1,
      formation: FORMATION.RING,
      anchorX: 4000,
      anchorY: 2000,
      count: 400,
    };
    for (const p of parts) {
      p.horde.spawn(secondWave);
    }

    advance(parts, FIRST_LEG, FIRST_LEG + SECOND_LEG, stats);

    process.stdout.write(
      `derive maximale observee (seconde vague) : ${stats.maxDrift.toFixed(3)} px sur ${FIRST_LEG + SECOND_LEG} pas\n`,
    );

    expect(stats.identityMismatches).toBe(0);
    expect(stats.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('mesure la derive due a une apparition tardive (latence reseau simulee)', () => {
    // Ce test ne verrouille pas une garantie, il MESURE un phenomene attendu.
    // `Room.step` (tache 9) fait apparaitre une vague au tick decide par le
    // serveur ; un client reel ne peut pas faire de meme au meme tick — l'ordre
    // met du temps a traverser le reseau. Il l'appliquera donc un ou deux ticks
    // plus tard (33 a 66 ms a 30 Hz), et ses entites auront alors ete avancees
    // d'un ou deux pas de moins que celles du serveur : c'est une consequence
    // de la latence, pas un bug de replication. Le chiffre mesure ici sert a
    // decider, a la tache 13, si le client doit rattraper les pas manques ou
    // simplement partir en retard.
    const mapSeed = 0x5eed_1a7e;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }

    const SPAWN_TICK = 100;
    const END = 400;
    // Retard d'apparition par participant, en ticks : 0 pour la reference (le
    // serveur), 1 tick pour deux clients (33 ms de latence), 2 ticks pour les
    // deux autres (66 ms).
    const SPAWN_DELAY: readonly number[] = [0, 1, 1, 2, 2];

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: SPAWN_TICK,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((p) => 3000 + Math.cos(tick * 0.02 + p) * 1500);
      const ys = [0, 1, 2, 3].map((p) => 3000 + Math.sin(tick * 0.02 + p) * 1500);

      parts.forEach((p, i) => {
        p.history.record(tick, xs, ys);

        if (tick % stepsPerField === 0) {
          const seen = p.history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }

        if (tick === SPAWN_TICK + (SPAWN_DELAY[i] ?? 0)) {
          p.horde.spawn(order);
        }

        p.horde.step(DT, p.fields);
      });

      // On ne compare que les entites que la reference ET le participant ont
      // deja fait apparaitre : avant que son ordre (retarde) n'arrive, un
      // participant n'a simplement pas encore ces entites — ce n'est pas un
      // mesappariement d'identite, juste une absence temporaire.
      for (const p of parts.slice(1)) {
        const count = Math.min(reference.horde.count, p.horde.count);
        for (let i = 0; i < count; i++) {
          const drift = Math.hypot(
            (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
            (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
          );
          if (drift > stats.maxDrift) {
            stats.maxDrift = drift;
          }

          if (p.horde.entityIdAt(i) !== reference.horde.entityIdAt(i)) {
            stats.identityMismatches++;
          }
        }
      }
    }

    process.stdout.write(
      `derive due a une apparition tardive (1-2 ticks) : ${stats.maxDrift.toFixed(3)} px\n`,
    );

    // L'identite est arithmetique (shared/horde.ts) : elle ne depend que de
    // waveId et de l'index dans la vague, jamais du tick d'apparition. Elle
    // doit donc rester strictement identique, meme quand les horloges
    // d'apparition different.
    expect(stats.identityMismatches).toBe(0);
    // Pas de seuil serre ici : ce cas n'est pas cense respecter DRIFT_LIMIT_PX,
    // puisqu'un ou deux pas de simulation manquent reellement. La mesure
    // attendue est ~694 px (voir §6.2 de la spec) ; cette borne n'est pas une
    // garantie, juste un filet contre une explosion.
    expect(stats.maxDrift).toBeLessThan(800);
  });

  it('avec spawnCatchingUp, la derive tardive redevient constante et petite', () => {
    // Meme scenario que le test precedent — meme apparition tardive de 1 a 2
    // ticks — mais chaque participant rattrape ses pas manques a l'apparition
    // via `Horde.spawnCatchingUp`. Mesure : la derive tombe de ~694 px a
    // ~20 px et cesse de croitre avec le temps (§6.2 de la spec).
    const mapSeed = 0x5eed_1a7e;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }

    const SPAWN_TICK = 100;
    const END = 400;
    const SPAWN_DELAY: readonly number[] = [0, 1, 1, 2, 2];

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: SPAWN_TICK,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((p) => 3000 + Math.cos(tick * 0.02 + p) * 1500);
      const ys = [0, 1, 2, 3].map((p) => 3000 + Math.sin(tick * 0.02 + p) * 1500);

      parts.forEach((p, i) => {
        p.history.record(tick, xs, ys);

        // Le rattrapage consomme le champ **avant** le rafraichissement
        // periodique de ce tick, pas apres : sur un vrai client, un
        // `WAVE_ORDER` est traite des sa reception (`#onFrame`), independamment
        // et generalement avant l'avancement de la horde du meme tick
        // (`#advanceHorde`). Rattraper avec un champ deja rafraichi ce tick-la
        // reviendrait a utiliser une entree que le serveur, lui, n'a vue qu'au
        // tick suivant — et rouvre la meme sensibilite aux frontieres de
        // cellules que le rattrapage cherche a eviter (§6.2 de la spec).
        const delay = SPAWN_DELAY[i] ?? 0;
        if (tick === SPAWN_TICK + delay) {
          p.horde.spawnCatchingUp(order, delay, DT, p.fields);
        }

        if (tick % stepsPerField === 0) {
          const seen = p.history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }

        p.horde.step(DT, p.fields);
      });

      for (const p of parts.slice(1)) {
        const count = Math.min(reference.horde.count, p.horde.count);
        for (let i = 0; i < count; i++) {
          const drift = Math.hypot(
            (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
            (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
          );
          if (drift > stats.maxDrift) {
            stats.maxDrift = drift;
          }

          if (p.horde.entityIdAt(i) !== reference.horde.entityIdAt(i)) {
            stats.identityMismatches++;
          }
        }
      }
    }

    process.stdout.write(
      `derive due a une apparition tardive, avec rattrapage : ${stats.maxDrift.toFixed(3)} px\n`,
    );

    expect(stats.identityMismatches).toBe(0);
    // Le double des 20,3 px mesures : marge pour ne pas etre fragile, tout en
    // verrouillant que le rattrapage ramene bien la derive a une constante
    // petite plutot qu'a une croissance lineaire.
    expect(stats.maxDrift).toBeLessThan(40);
  });

  it('reproduit la configuration reelle : un serveur et quatre clients, chacun dans son propre ordre de tick', () => {
    // Les deux tests precedents ont chacun valide un seul ordre — soit tout le
    // monde en sequence serveur, soit tout le monde en sequence client — mais
    // jamais confronte les deux entre eux. Or la partie reelle n'est ni l'un
    // ni l'autre : c'est UN serveur qui suit `Room.step`
    // (enregistrement -> rafraichissement -> spawn simple -> avancement) et
    // QUATRE clients qui suivent `GameClient#advanceHorde`
    // (rattrapage -> enregistrement -> rafraichissement -> avancement). Rien
    // n'avait encore mesure la derive entre ces deux ordres.
    const mapSeed = 0x5eed_1a7e;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }

    const SPAWN_TICK = 100;
    const END = 400;
    // Retard d'apparition : 0 pour la reference (le serveur apparait au tick
    // exact, sans rattrapage a se faire a lui-meme), 1 ou 2 ticks pour les
    // quatre clients (33 a 66 ms de latence reseau simulee).
    const SPAWN_DELAY: readonly number[] = [0, 1, 1, 2, 2];

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: SPAWN_TICK,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((p) => 3000 + Math.cos(tick * 0.02 + p) * 1500);
      const ys = [0, 1, 2, 3].map((p) => 3000 + Math.sin(tick * 0.02 + p) * 1500);

      parts.forEach((p, i) => {
        if (i === 0) {
          // Sequence du serveur (`Room.step`, tache 9) : enregistrement,
          // rafraichissement periodique, puis apparition simple — le serveur
          // n'est jamais en retard sur son propre tick, donc pas de
          // rattrapage a faire.
          p.history.record(tick, xs, ys);

          if (tick % stepsPerField === 0) {
            const seen = p.history.delayed(tick);
            if (seen) {
              for (let f = 0; f < 4; f++) {
                p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
              }
              p.horde.retarget(seen.x, seen.y);
            }
          }

          if (tick === SPAWN_TICK) {
            p.horde.spawn(order);
          }

          p.horde.step(DT, p.fields);
          return;
        }

        // Sequence du client (`GameClient#advanceHorde`, tache 13) : les
        // ordres en attente s'appliquent EN TETE de tick, avant tout
        // enregistrement et tout rafraichissement du champ.
        const delay = SPAWN_DELAY[i] ?? 0;
        if (tick === SPAWN_TICK + delay) {
          p.horde.spawnCatchingUp(order, delay, DT, p.fields);
        }

        p.history.record(tick, xs, ys);

        if (tick % stepsPerField === 0) {
          const seen = p.history.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }

        p.horde.step(DT, p.fields);
      });

      for (const p of parts.slice(1)) {
        const count = Math.min(reference.horde.count, p.horde.count);
        for (let i = 0; i < count; i++) {
          const drift = Math.hypot(
            (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
            (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
          );
          if (drift > stats.maxDrift) {
            stats.maxDrift = drift;
          }

          if (p.horde.entityIdAt(i) !== reference.horde.entityIdAt(i)) {
            stats.identityMismatches++;
          }
        }
      }
    }

    process.stdout.write(
      `derive serveur (record->rafraichissement->spawn) vs client (rattrapage->record->rafraichissement) : ${stats.maxDrift.toFixed(3)} px\n`,
    );

    expect(stats.identityMismatches).toBe(0);
    // Borne large et deliberement distincte de DRIFT_LIMIT_PX : ce test ne
    // verrouille pas une garantie fine puisque les deux ordres different
    // reellement, il attrape seulement une explosion qui signalerait que les
    // deux sequences ne sont pas compatibles entre elles.
    expect(stats.maxDrift).toBeLessThan(200);
  });

  /**
   * C1 — le defaut que les cinq scenarios ci-dessus ne peuvent pas voir.
   *
   * Ils donnent tous, a TOUS les participants, exactement le meme tableau de
   * positions sous exactement la meme cle de tick — `p.history.record(tick,
   * xs, ys)`, ou `tick` est la variable de boucle commune. Structurellement,
   * ca ne peut pas reveler le bug reel : `SnapshotBuffer.latest()` (cote
   * client) jette le tick du serveur, et le client enregistre alors le
   * contenu du dernier snapshot recu sous SA PROPRE cle de tick locale — qui
   * n'a plus aucune raison de coincider avec le tick auquel ce contenu a ete
   * produit cote serveur.
   *
   * Les deux scenarios ci-dessous modelisent ce que fait REELLEMENT le
   * reseau, chacun avec une sequence de client differente :
   *
   * - la reference joue le serveur : elle enregistre les positions
   *   ARRONDIES du tick courant sous ce tick (le client ne connaitra jamais
   *   que la version quantifiee en int16 du protocole, jamais le flottant) ;
   * - chaque client recoit ces memes positions arrondies avec 1 a 3 ticks de
   *   retard reseau ;
   * - le compteur de tick local de chaque client demarre DECALE, comme le
   *   produirait un `WELCOME` lui-meme arrive apres un temps de trajet.
   */
  function makeC1Scenario(options: {
    /** Enregistre sous le tick local du client plutot que sous le tick serveur d'origine. */
    recordUnderLocalClientTick: boolean;
    /** Recale en continu le compteur de tick local sur le dernier tick serveur connu. */
    resyncLocalClientTick: boolean;
  }): DriftStats {
    const mapSeed = 0xdec1de5;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }

    const SPAWN_TICK = 50;
    const END = 500;
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const round = (v: number) => Math.round(v);

    // Retard reseau de reception des positions, en ticks : 1 a 3, comme
    // l'annonce le constat C1. Zero pour la reference : c'est le serveur.
    const NETWORK_DELAY: readonly number[] = [0, 1, 2, 3, 2];
    // Decalage initial du compteur de tick client, tel que le produirait un
    // WELCOME arrive apres un temps de trajet non nul — jamais zero en vrai.
    const CLOCK_SKEW: readonly number[] = [0, 4, 7, 2, 5];
    // Tolerance de retard : au-dela, le compteur local est considere trop en
    // retard sur le tick serveur connu (onglet en arriere-plan, sursaut de
    // latence) et on le rattrape plutot que de laisser l'ecart s'installer
    // pour de bon (correction C1.3). Volontairement asymetrique : le
    // compteur local a de bonnes raisons d'etre EN AVANCE sur le dernier
    // snapshot connu — c'est la latence reseau elle-meme, deja absorbee par
    // `FIELD_INPUT_DELAY_TICKS` — donc seul un retard doit corriger.
    //
    // La valeur elle-meme est mesuree, pas devinee : ce champ de directions
    // discret est sensible au point de faire la difference entre 0 et plus de
    // 600 px de derive selon qu'un retard persistant de 1 ou de 2 ticks est
    // tolere (voir le rapport final). D'ou une tolerance serree.
    const CATCHUP_TOLERANCE = 1;

    // Compteur de tick local de chaque client, initialise en retard comme le
    // ferait un WELCOME tardif. Index 0 (la reference) n'est jamais lu.
    const localTick = parts.map((_, i) => -(CLOCK_SKEW[i] ?? 0));

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: SPAWN_TICK,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITIES,
    };

    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };

    for (let tick = 0; tick < END; tick++) {
      parts.forEach((p, i) => {
        if (tick === SPAWN_TICK) {
          // Spawn synchrone, sans latence : ce scenario isole la derive du
          // flowfield due a C1, pas celle de l'apparition tardive (scenarios
          // precedents).
          p.horde.spawn(order);
        }

        if (i === 0) {
          // Le serveur : positions arrondies, enregistrees sous le tick vrai.
          const xs = [0, 1, 2, 3].map((pl) => round(3000 + Math.cos(tick * 0.02 + pl) * 1500));
          const ys = [0, 1, 2, 3].map((pl) => round(3000 + Math.sin(tick * 0.02 + pl) * 1500));
          p.history.record(tick, xs, ys);
          if (tick % stepsPerField === 0) {
            const seen = p.history.delayed(tick);
            if (seen) {
              for (let f = 0; f < 4; f++) {
                p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
              }
              p.horde.retarget(seen.x, seen.y);
            }
          }
          p.horde.step(DT, p.fields);
          return;
        }

        // Un client : recoit les positions du tick `tick - latence`, deja
        // arrondies par le serveur qui les a emises.
        const delay = NETWORK_DELAY[i] ?? 0;
        const receivedServerTick = Math.max(0, tick - delay);
        const rxs = [0, 1, 2, 3].map((pl) =>
          round(3000 + Math.cos(receivedServerTick * 0.02 + pl) * 1500),
        );
        const rys = [0, 1, 2, 3].map((pl) =>
          round(3000 + Math.sin(receivedServerTick * 0.02 + pl) * 1500),
        );

        if (options.resyncLocalClientTick) {
          const current = localTick[i] ?? 0;
          // Rattrapage a SENS UNIQUE : on ne corrige que si le compteur local
          // est trop EN RETARD sur le dernier tick serveur connu. Etre en
          // avance de `delay` ticks est le fonctionnement normal — le
          // compteur local suit le temps reel, le dernier snapshot connu est
          // necessairement plus vieux que maintenant. Recaler aussi dans ce
          // sens-la reviendrait a figer en permanence le compteur local sur
          // le tick (deja perime) du dernier snapshot recu, ce qui annule
          // l'absorption de latence de `FIELD_INPUT_DELAY_TICKS`.
          localTick[i] =
            receivedServerTick - current > CATCHUP_TOLERANCE ? receivedServerTick : current + 1;
        } else {
          // Jamais recale : c'est exactement le defaut C1.b — le compteur
          // avance a son propre rythme, indefiniment decale.
          localTick[i] = (localTick[i] ?? 0) + 1;
        }

        const key = options.recordUnderLocalClientTick ? (localTick[i] ?? 0) : receivedServerTick;
        p.history.record(key, rxs, rys);

        const queryTick = localTick[i] ?? 0;
        if (queryTick % stepsPerField === 0) {
          const seen = p.history.delayed(queryTick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }
        p.horde.step(DT, p.fields);
      });

      for (const p of parts.slice(1)) {
        const count = Math.min(reference.horde.count, p.horde.count);
        for (let i = 0; i < count; i++) {
          const drift = Math.hypot(
            (p.horde.x[i] ?? 0) - (reference.horde.x[i] ?? 0),
            (p.horde.y[i] ?? 0) - (reference.horde.y[i] ?? 0),
          );
          if (drift > stats.maxDrift) {
            stats.maxDrift = drift;
          }
          if (p.horde.entityIdAt(i) !== reference.horde.entityIdAt(i)) {
            stats.identityMismatches++;
          }
        }
      }
    }

    return stats;
  }

  it(
    'C1 — sans les corrections, le client indexe l historique sous son propre tick, ' +
      'jamais recale : la derive explose',
    () => {
      const stats = makeC1Scenario({
        recordUnderLocalClientTick: true,
        resyncLocalClientTick: false,
      });

      process.stdout.write(
        `C1 AVANT correction (tick local jamais recale) : derive maximale ${stats.maxDrift.toFixed(3)} px\n`,
      );

      // L'identite reste exacte : ce defaut est purement une derive de
      // position, pas de comptabilite d'entites.
      expect(stats.identityMismatches).toBe(0);
      // Le point du test : la derive n'est PAS bornee a une valeur cosmetique
      // comme dans les scenarios precedents. Si cette assertion passait, ce
      // scenario ne modeliserait pas la latence reelle et devrait etre repris.
      expect(stats.maxDrift).toBeGreaterThan(DRIFT_LIMIT_PX * 20);
    },
  );

  it(
    'C1 — avec les corrections (tick serveur, recalage continu), la derive sous latence ' +
      'simulee redevient petite',
    () => {
      const stats = makeC1Scenario({
        recordUnderLocalClientTick: false,
        resyncLocalClientTick: true,
      });

      process.stdout.write(
        `C1 APRES correction (tick serveur, recale en continu) : derive maximale ${stats.maxDrift.toFixed(3)} px\n`,
      );

      expect(stats.identityMismatches).toBe(0);
      // Meme ordre de grandeur que le rattrapage a l'apparition (scenario
      // precedent) : l'erreur residuelle de fraicheur du champ, pas une
      // derive qui grossit avec le temps.
      expect(stats.maxDrift).toBeLessThan(40);
    },
  );
});
