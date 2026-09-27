import { describe, expect, it } from 'vitest';

import { archetypeOf } from './archetypes';
import { BOSS_CHARGE_LENGTH_PX, type BossCharge, makeBossCharge } from './boss';
import {
  FLOWFIELD_CELL,
  FLOWFIELD_HZ,
  MAP_SIZE,
  ROLLBACK_DEPTH_TICKS,
  TICK_HZ,
  ZONE_LIFETIME_TICKS,
} from './constants';
import { ELEMENT, elementOf } from './elements';
import { FlowField } from './flowfield';
import { entityIdOf, Horde } from './horde';
import { HordeHistory } from './horde-history';
import { hpScale } from './paliers';
import { PlayerHistory } from './player-history';
import { packZoneKind } from './protocol';
import { REACTION, zoneLifetimeTicks } from './reactions';
import { FORMATION, type WaveOrder } from './waves';
import { applyObstacles, generateObstacles } from './worldmap';
import { ZoneField } from './zones';

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

      p.horde.step(DT, p.fields, tick);
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

        p.horde.step(DT, p.fields, tick);
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
    // attendue etait ~694 px avant la tache 19 (voir §6.2 de la spec) ; le
    // recalcul de trajectoire par intervalle (tache 19) l'a fait monter vers
    // ~1450 px — une entite qui recalcule un tick sur K tient une direction
    // quantifiee par cellule de flowfield jusqu'a K fois plus longtemps
    // qu'avant, ce qui laisse plus de temps a un choix de cellule divergent de
    // se propager avant correction. Borne large, toujours un filet contre une
    // explosion, jamais une garantie de precision.
    expect(stats.maxDrift).toBeLessThan(2000);
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

        p.horde.step(DT, p.fields, tick);
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
    // Le double des 20,3 px mesures a l'origine (tache 13) : marge pour ne
    // pas etre fragile, tout en verrouillant que le rattrapage ramene bien la
    // derive a une constante petite plutot qu'a une croissance lineaire.
    //
    // ⚠️ La tache 19 avait fait monter cette mesure a 1220 px : le rattrapage
    // avancait alors le long du champ (`#advanceAlongField`) pendant que la
    // boucle normale avancait selon une vitesse tenue (`#advanceByVelocity`)
    // — deux physiques differentes, qui divergeaient des le premier tick. La
    // tache 20 unifie les deux chemins : le rattrapage recalcule desormais la
    // trajectoire par phase et avance par vitesse tenue, EXACTEMENT comme la
    // boucle normale, restreint aux seules entites qu'il vient de faire
    // naitre (voir la doc de `Horde.spawnCatchingUp`). Mesure : retour a
    // 0,000 px, exactement comme avant la tache 19.
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
            // `p.fields[0]` : tache 18, evite de faire naitre une entite en
            // plein mur — exactement ce que fait `Room.step` cote serveur
            // (`back/src/room.ts`). Un appel sans obstacles ici desaccorderait
            // ce test de son propre modele : le client, lui, passe TOUJOURS
            // par `spawnCatchingUp`, qui applique deja ce meme evitement (voir
            // sa doc dans `shared/horde.ts`).
            p.horde.spawn(order, p.fields[0]);
          }

          p.horde.step(DT, p.fields, tick);
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

        p.horde.step(DT, p.fields, tick);
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
    //
    // ⚠️ La tache 19 avait fait monter cette mesure a 1220 px, pour la meme
    // raison que le test precedent (deux physiques de rattrapage differentes,
    // voir sa doc) ; la tache 20 l'unifie et ramene la mesure a 0,000 px,
    // exactement comme avant la tache 19 — d'ou le retour a 200 px.
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
          p.horde.step(DT, p.fields, tick);
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
        // Le compteur de tick LOCAL du client, pas le tick vrai de la boucle
        // (`tick`) : c'est exactement ce que ferait `GameClient#advanceHorde`,
        // qui n'a jamais acces au tick serveur absolu autrement que via ce
        // compteur resynchronise (ou non, selon le scenario) — voir la doc de
        // `Horde.step` sur la phase de recalcul de trajectoire.
        p.horde.step(DT, p.fields, queryTick);
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

/**
 * Le livrable de l'etape 3 : la replication survit-elle aux morts, une fois la
 * separation en jeu ?
 *
 * La repulsion COUPLE les entites (`Horde#recomputeSteering`, tache 19) :
 * retirer un ennemi ne decale plus une seule entite mais des dizaines, de
 * proche en proche. Une mort appliquee un tick trop tard ne se noie plus
 * dans le bruit —
 * elle propage un ecart qui ne s'eteint plus. L'etape 2 a mesure ce que ca
 * donne pour l'apparition tardive d'une vague : 694 px apres dix secondes, sans
 * borne. La parade est le rejeu : `HordeHistory` (tache 3) restaure la horde au
 * tick de la mort, l'applique, puis rejoue le mouvement jusqu'au present.
 *
 * Comme le reste du fichier, ce bloc modelise ses clients lui-meme plutot que
 * d'importer `GameClient` : c'est la seule maniere de controler la latence
 * observee ici. Le signal "mort trop vieille" est donc un compteur local
 * (`lateDeaths`), pas celui de `GameClient` — la tache 10 recablera le meme
 * signal a cet endroit-la.
 */
describe('etape 3 : les morts survivent a la separation, avec et sans rejeu', () => {
  const WAVE_ID = 1;
  // Assez tot pour laisser la horde se former sous la separation avant la
  // premiere mort, assez espace (~12 ticks) pour que chaque lot ait fini de se
  // propager a tous les participants avant le suivant — sans quoi deux lots en
  // vol se melangeraient et la mesure ne distinguerait plus rien.
  //
  // ⚠️ 151 et 13, PAS 150 et 12 : les deux valeurs sont choisies pour ne JAMAIS
  // etre multiples de `stepsPerField` (3, = TICK_HZ/FLOWFIELD_HZ). Avec 150 et
  // 12 (tous deux multiples de 3), chaque `deathTick` qui atteint reellement
  // `primeFieldForReplay` tombe pile sur une frontiere de rafraichissement — et
  // sur une frontiere, amorcer le champ AU tick de la mort ou au DERNIER
  // rafraichissement du (`lastDue`) donnent la meme reponse, puisque les deux
  // coincident. Un `primeFieldForReplay` qui utiliserait directement `atTick`
  // au lieu de le ramener a `lastDue` — c'est-a-dire correct seulement sur les
  // frontieres, faux ailleurs — passerait alors inapercu : ce fut le cas ici
  // (ronde de correction 1), les dix tests passaient et le scenario 9
  // rapportait toujours 0,000 px, malgre l'erreur. Avec 151 et 13 (13 n'est
  // pas multiple de 3), les `deathTick` successifs parcourent les trois restes
  // possibles modulo 3 (151%3=1, 164%3=2, 177%3=0, ...) : un rejeu qui ne
  // ramenerait pas correctement `atTick` a `lastDue` echoue desormais sur les
  // deux tiers des lots. Verifie par instrumentation (voir le rapport de la
  // tache 8, section « Ronde de correction 1 ») : zero appel non aligne avec
  // l'ancien calendrier, une majorite d'appels non alignes avec celui-ci.
  const DEATH_START = 151;
  const DEATH_INTERVAL = 13;
  const DEATH_BATCH = 12;
  const DEATH_BATCHES = 18;
  // Retard reseau d'application de la mort, en ticks : 0 pour la reference (le
  // serveur arbitre et applique au meme instant), 1 a 3 pour les clients — comme
  // l'exige la tache 8. Bien en-deca de ROLLBACK_DEPTH_TICKS(8) : les scenarios
  // 8 et 9 verifient ce que fait — ou ne fait pas — le rejeu DANS la portee de
  // l'anneau ; le scenario 10, plus bas, verifie ce qui se passe en dehors.
  const CLIENT_DELAY: readonly number[] = [0, 1, 2, 3, 2];

  interface DeathParticipant {
    horde: Horde;
    fields: FlowField[];
    playerHistory: PlayerHistory;
    hordeHistory: HordeHistory;
    /** Compteur de morts appliquees au present faute d'anneau assez profond (scenario 10). */
    lateDeaths: number;
  }

  function makeDeathParticipant(mapSeed: number): DeathParticipant {
    const horde = new Horde(4000);
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
    const fields = Array.from({ length: 4 }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    return {
      horde,
      fields,
      playerHistory: new PlayerHistory(),
      hordeHistory: new HordeHistory(horde.capacity),
      lateDeaths: 0,
    };
  }

  interface DeathBatch {
    tick: number;
    ids: number[];
  }

  /**
   * Calendrier de morts, pur et connu d'avance : quel index de vague meurt a
   * quel tick serveur. Arithmetique plutot que tire au sort — `shared/` n'a pas
   * le droit a `Math.random` (voir `random.ts`) — et surtout INDEPENDANT de
   * l'etat simule : le serveur et chaque client recoivent exactement les memes
   * identites, seul le moment ou ils les appliquent differe.
   */
  function makeDeathSchedule(): DeathBatch[] {
    const schedule: DeathBatch[] = [];
    for (let b = 0; b < DEATH_BATCHES; b++) {
      const ids: number[] = [];
      for (let k = 0; k < DEATH_BATCH; k++) {
        ids.push(entityIdOf(WAVE_ID, b * DEATH_BATCH + k));
      }
      schedule.push({ tick: DEATH_START + b * DEATH_INTERVAL, ids });
    }
    return schedule;
  }

  /**
   * Associe a chaque index de vague le creneau qui le porte actuellement, ou -1
   * s'il est mort.
   *
   * Une mort compacte le tableau (`Horde.kill`) : deux participants qui n'ont
   * pas encore recu la meme mort ont des tableaux ranges differemment, et
   * comparer par INDICE DE CRENEAU comparerait alors deux entites differentes —
   * pas un bug de replication, un artefact de la methode de mesure. Comparer
   * par IDENTITE (l'index de vague, qui ne bouge jamais, contrairement au
   * creneau) evite le piege.
   */
  function slotByWaveIndex(horde: Horde): Int32Array {
    const out = new Int32Array(ENTITIES).fill(-1);
    for (let slot = 0; slot < horde.count; slot++) {
      const idx = horde.indexInWave[slot] ?? 0;
      if (idx < ENTITIES) {
        out[idx] = slot;
      }
    }
    return out;
  }

  /**
   * Derive maximale entre deux hordes, appariees par identite plutot que par
   * indice de creneau (voir `slotByWaveIndex`). Une entite morte d'un seul cote
   * — la fenetre normale entre l'application serveur et l'application client
   * retardee — est ignoree : c'est une absence temporaire, pas une derive de
   * position a mesurer.
   */
  function measureDrift(reference: Horde, participant: Horde): number {
    const refSlots = slotByWaveIndex(reference);
    const partSlots = slotByWaveIndex(participant);
    let maxDrift = 0;
    for (let e = 0; e < ENTITIES; e++) {
      const rs = refSlots[e] ?? -1;
      const ps = partSlots[e] ?? -1;
      if (rs < 0 || ps < 0) {
        continue;
      }
      const drift = Math.hypot(
        (participant.x[ps] ?? 0) - (reference.x[rs] ?? 0),
        (participant.y[ps] ?? 0) - (reference.y[rs] ?? 0),
      );
      if (drift > maxDrift) {
        maxDrift = drift;
      }
    }
    return maxDrift;
  }

  /** Index de vague encore vivants, tries : pour comparer deux ensembles d'identites terme a terme. */
  function aliveWaveIndices(horde: Horde): number[] {
    const out: number[] = [];
    for (let slot = 0; slot < horde.count; slot++) {
      out.push(horde.indexInWave[slot] ?? 0);
    }
    return out.sort((a, b) => a - b);
  }

  /**
   * Un pas de rejeu : les etapes 4 et 6 de la sequence serveur (rafraichir le
   * champ si du, avancer la horde — recalcul de trajectoire par phase inclus,
   * tache 19) — jamais l'arbitrage (etapes 7-9), qui reste la prerogative du
   * serveur. Rejouer l'arbitrage prononcerait des morts que le serveur n'a
   * pas decidees, et ferait diverger le client precisement la ou le rejeu
   * cherche a le faire converger.
   *
   * Reecrit aussi l'anneau pour ce tick avec l'etat corrige : une mort
   * suivante qui viserait l'un de ces ticks doit restaurer la version rejouee,
   * pas l'ancienne version — celle d'avant la correction qu'on vient de faire.
   *
   * ⚠️ `tick` est passe TEL QUEL a `Horde.step` : c'est le meme tick absolu
   * que celui utilise par la simulation d'origine, condition pour que la
   * phase de recalcul de trajectoire (tache 19) reste identique au rejeu.
   */
  function replayTick(p: DeathParticipant, tick: number, stepsPerField: number): void {
    if (tick % stepsPerField === 0) {
      const seen = p.playerHistory.delayed(tick);
      if (seen) {
        for (let f = 0; f < 4; f++) {
          p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        p.horde.retarget(seen.x, seen.y);
      }
    }
    p.horde.step(DT, p.fields, tick);
    p.hordeHistory.record(tick, p.horde);
  }

  /**
   * Applique une mort en retard SANS rejeu : directement sur l'etat present.
   * C'est le defaut que la tache 3 corrige — voir le scenario 8.
   */
  function applyDeathWithoutReplay(p: DeathParticipant, ids: readonly number[]): void {
    p.horde.kill(ids);
  }

  /**
   * Remet le champ a son contenu du tick `atTick`, avant de commencer le rejeu.
   *
   * ⚠️ Piege qu'un premier essai de ce fichier a bel et bien fait tomber dans
   * ce test (derive mesuree : 709 px, l'ordre de grandeur des 694/769 px de
   * l'etape 2 — voir le rapport de la tache 8). `HordeHistory.restore` remet la
   * HORDE a l'etat du tick de la mort, mais le `FlowField` est un objet mutable
   * PARTAGE, jamais restaure par l'anneau : au moment ou le rejeu commence, il
   * porte encore le contenu du DERNIER rafraichissement reel — celui du tick
   * present, plusieurs generations plus frais que ce que le serveur avait sous
   * les yeux au tick de la mort. `replayTick` ne rafraichit qu'aux ticks
   * effectivement dus (`tick % stepsPerField === 0`) ; tant que le rejeu n'a pas
   * atteint le premier de ces ticks, il avancerait avec un champ trop frais —
   * exactement le defaut documente sur `Horde.spawnCatchingUp`. Cette fonction
   * revient d'abord au dernier rafraichissement du a `atTick` ou avant, pour que
   * le rejeu reparte d'un champ dont l'age correspond a celui du tick restaure.
   */
  function primeFieldForReplay(p: DeathParticipant, atTick: number, stepsPerField: number): void {
    const lastDue = atTick - (((atTick % stepsPerField) + stepsPerField) % stepsPerField);
    const seen = p.playerHistory.delayed(lastDue);
    if (seen) {
      for (let f = 0; f < 4; f++) {
        p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
      }
    }
  }

  /**
   * Applique une mort en retard AVEC rejeu : restaure l'etat du tick de la
   * mort, applique, rejoue jusqu'au present. Si ce tick est sorti de l'anneau
   * (`ROLLBACK_DEPTH_TICKS`), retombe sur une application au present et le
   * SIGNALE via `p.lateDeaths` plutot que de le faire en silence — le pendant
   * de `GameClient#applyDeaths` (tache 10).
   */
  function applyDeathWithReplay(
    p: DeathParticipant,
    deathTick: number,
    ids: readonly number[],
    currentTick: number,
    stepsPerField: number,
  ): void {
    if (!p.hordeHistory.restore(deathTick, p.horde)) {
      p.lateDeaths += ids.length;
      p.horde.kill(ids);
      return;
    }
    p.horde.kill(ids);
    primeFieldForReplay(p, deathTick, stepsPerField);
    for (let t = deathTick + 1; t <= currentTick; t++) {
      replayTick(p, t, stepsPerField);
    }
  }

  interface DeathScenarioResult {
    reference: Horde;
    clients: DeathParticipant[];
    maxDrift: number;
    travelled: number;
  }

  /**
   * Le scenario commun aux tests 8 et 9 : cinq participants (un serveur, quatre
   * clients), une horde de 1000 entites sous separation active, et un
   * calendrier de morts que le serveur applique a l'instant decide tandis que
   * chaque client l'apprend 1 a 3 ticks plus tard. `withReplay` bascule entre
   * les deux strategies d'application — c'est la SEULE difference entre les
   * scenarios 8 et 9, comme le demande le plan.
   *
   * Le mouvement des joueurs, lui, n'est PAS retarde ici : la latence testee
   * est celle DES MORTS, isolee de la latence de position deja couverte par les
   * scenarios C1 plus haut. Melanger les deux rendrait impossible de dire
   * laquelle produit quelle part de la derive mesuree.
   */
  function runDeathScenario(mapSeed: number, withReplay: boolean): DeathScenarioResult {
    const parts = Array.from({ length: PARTICIPANTS }, () => makeDeathParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }
    const clients = parts.slice(1);

    const order: WaveOrder = {
      waveId: WAVE_ID,
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

    const schedule = makeDeathSchedule();
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const END = DEATH_START + DEATH_BATCHES * DEATH_INTERVAL + 60;

    let maxDrift = 0;
    let travelled = 0;
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    // Un index de vague qui n'entre jamais dans le calendrier de morts (0..215
    // seulement) : il survit tout le run, et sert a prouver que la horde a
    // reellement avance — une derive nulle peut vouloir dire "rien n'a bouge"
    // autant que "replication parfaite".
    const trackedId = entityIdOf(WAVE_ID, ENTITIES - 1);
    // Vrai tant qu'un client n'a pas encore recu (et, si `withReplay`, rejoue)
    // une mort que le serveur a deja decidee. Pendant cette fenetre, le client
    // porte encore des voisins que le serveur a deja retires : la separation
    // les pousse different, et cet ecart est du au transit reseau lui-meme, pas
    // a une imprecision du rejeu — le rejeu ne peut corriger que ce qui arrive
    // APRES qu'il ait tourne, jamais les instants ou le message est encore en
    // vol. Le mesurer la melangerait avec la seule chose que 8 et 9 cherchent a
    // isoler : la qualite de la correction UNE FOIS appliquee. Meme principe
    // que « on ne compare que les entites deja apparues » pour l'apparition
    // tardive, applique cette fois a la disparition.
    const pendingDeath: boolean[] = clients.map(() => false);

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((pl) => 3000 + Math.cos(tick * 0.02 + pl) * 1500);
      const ys = [0, 1, 2, 3].map((pl) => 3000 + Math.sin(tick * 0.02 + pl) * 1500);

      for (const p of parts) {
        p.playerHistory.record(tick, xs, ys);
        if (tick % stepsPerField === 0) {
          const seen = p.playerHistory.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }
        p.horde.step(DT, p.fields, tick);
      }

      // Le serveur arbitre et applique a l'instant meme : il n'a jamais besoin
      // de rejeu pour ses propres decisions, seuls les clients en ont besoin.
      let decidedThisTick = false;
      for (const batch of schedule) {
        if (batch.tick === tick) {
          reference.horde.kill(batch.ids);
          decidedThisTick = true;
        }
      }
      if (decidedThisTick) {
        pendingDeath.fill(true);
      }

      // Chaque client enregistre SON etat — avant de savoir quoi que ce soit
      // d'une mort qui arriverait tout juste — puis regarde si un message de
      // mort programme plus tot arrive precisement maintenant, avec son propre
      // retard.
      clients.forEach((p, i) => {
        p.hordeHistory.record(tick, p.horde);
        const delay = CLIENT_DELAY[i + 1] ?? 0;
        for (const batch of schedule) {
          if (batch.tick + delay === tick) {
            if (withReplay) {
              applyDeathWithReplay(p, batch.tick, batch.ids, tick, stepsPerField);
            } else {
              applyDeathWithoutReplay(p, batch.ids);
            }
            pendingDeath[i] = false;
          }
        }
      });

      clients.forEach((p, i) => {
        if (pendingDeath[i]) {
          return;
        }
        const drift = measureDrift(reference.horde, p.horde);
        if (drift > maxDrift) {
          maxDrift = drift;
        }
      });

      const trackedSlot = reference.horde.slotOf(trackedId);
      if (trackedSlot >= 0) {
        const x = reference.horde.x[trackedSlot] ?? 0;
        const y = reference.horde.y[trackedSlot] ?? 0;
        if (hasPrev) {
          travelled += Math.hypot(x - prevX, y - prevY);
        }
        prevX = x;
        prevY = y;
        hasPrev = true;
      }
    }

    return { reference: reference.horde, clients, maxDrift, travelled };
  }

  const TOTAL_KILLED = DEATH_BATCHES * DEATH_BATCH;

  it('scenario 8 — sans rejeu, morts + separation laissent une derive mesurable, le pendant des 694/769 px de l etape 2', () => {
    const result = runDeathScenario(0xd1e5_0008, false);

    process.stdout.write(
      `scenario 8 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
        `horde deplacee de ${result.travelled.toFixed(1)} px, ${TOTAL_KILLED} entites tuees sur ${ENTITIES}\n`,
    );

    // Le scenario ne prouve rien si rien n'est mort ou si rien n'a bouge (barre
    // de qualite de la tache 8) : ces trois assertions n'ont d'autre role que de
    // garantir que le chiffre affiche plus haut mesure quelque chose de reel.
    expect(result.reference.count).toBe(ENTITIES - TOTAL_KILLED);
    expect(TOTAL_KILLED).toBeGreaterThan(100);
    expect(result.travelled).toBeGreaterThan(500);

    // Borne large et volontaire : ce scenario existe pour que la derive EXISTE,
    // pas pour rester petite. La borne basse verifie que le chiffre est
    // reellement significatif — sinon les scenarios 8 et 9 rapporteraient tous
    // les deux ~0 et la latence simulee ne prouverait rien (barre de qualite de
    // la tache 8). La borne haute reste un filet contre une explosion, pas une
    // garantie de precision.
    //
    // ⚠️ 687,893 px avant la tache 19, 800 de borne haute ; le recalcul de
    // trajectoire par intervalle (tache 19) la fait monter vers ~1010 px —
    // c'est UN DES DEUX CHIFFRES QUE LA TACHE 19 S'ATTEND A VOIR BOUGER (voir
    // son rapport), la separation qu'il mesure n'etant plus recalculee a
    // chaque tick.
    expect(result.maxDrift).toBeGreaterThan(20);
    expect(result.maxDrift).toBeLessThan(1500);
  });

  it('scenario 9 — avec rejeu, les identites restent strictement egales et la derive retombe sous 2 px', () => {
    const result = runDeathScenario(0xd1e5_0009, true);

    process.stdout.write(
      `scenario 9 (avec rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px\n`,
    );

    expect(result.reference.count).toBe(ENTITIES - TOTAL_KILLED);
    expect(TOTAL_KILLED).toBeGreaterThan(100);
    expect(result.travelled).toBeGreaterThan(500);

    for (const p of result.clients) {
      // 1 a 3 ticks de retard tient largement dans ROLLBACK_DEPTH_TICKS(8) :
      // aucune mort ne devrait tomber dans le cas "trop vieux pour l'anneau"
      // (scenario 10).
      expect(p.lateDeaths).toBe(0);
      expect(p.horde.count).toBe(result.reference.count);
      // Assertion demandee par la tache : les identites sont STRICTEMENT
      // egales, pas seulement leur nombre. `toEqual` sur deux tableaux tries
      // donne, en cas d'echec, l'index de vague precis qui differe.
      expect(aliveWaveIndices(p.horde)).toEqual(aliveWaveIndices(result.reference));
    }

    expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('scenario 10 — une mort trop vieille pour l anneau est appliquee au present, signalee, sans planter, et sa derive residuelle mesuree', () => {
    const mapSeed = 0xd1e5_0010;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeDeathParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }
    const clients = parts.slice(1);

    const order: WaveOrder = {
      waveId: WAVE_ID,
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

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const DEATH_TICK = 100;
    const DEATH_IDS = Array.from({ length: 20 }, (_, k) => entityIdOf(WAVE_ID, k));
    // Strictement au-dela de ROLLBACK_DEPTH_TICKS(8), avec de la marge : sinon
    // l'anneau absorbe tout et ce scenario ne prouve rien (avertissement de la
    // tache 8).
    const LATE_DELAY = ROLLBACK_DEPTH_TICKS + 4;
    const END = DEATH_TICK + LATE_DELAY + 60;

    let maxDrift = 0;
    let travelled = 0;
    let prevX = 0;
    let prevY = 0;
    let hasPrev = false;
    const trackedId = entityIdOf(WAVE_ID, ENTITIES - 1);

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((pl) => 3000 + Math.cos(tick * 0.02 + pl) * 1500);
      const ys = [0, 1, 2, 3].map((pl) => 3000 + Math.sin(tick * 0.02 + pl) * 1500);

      for (const p of parts) {
        p.playerHistory.record(tick, xs, ys);
        if (tick % stepsPerField === 0) {
          const seen = p.playerHistory.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }
        p.horde.step(DT, p.fields, tick);
      }

      if (tick === DEATH_TICK) {
        reference.horde.kill(DEATH_IDS);
      }

      for (const p of clients) {
        p.hordeHistory.record(tick, p.horde);
        if (tick === DEATH_TICK + LATE_DELAY) {
          applyDeathWithReplay(p, DEATH_TICK, DEATH_IDS, tick, stepsPerField);
        }
      }

      // « Derive residuelle » se lit APRES application : entre DEATH_TICK et
      // son application tardive, le client porte encore les vingt entites que
      // le serveur a deja retirees, et la separation pousse leurs voisins
      // different — un ecart du au transit du message, pas au chemin de
      // secours qu'on cherche a mesurer ici (meme raisonnement que pour les
      // scenarios 8/9, voir `pendingDeath` plus haut).
      if (tick >= DEATH_TICK + LATE_DELAY) {
        for (const p of clients) {
          const drift = measureDrift(reference.horde, p.horde);
          if (drift > maxDrift) {
            maxDrift = drift;
          }
        }
      }

      const trackedSlot = reference.horde.slotOf(trackedId);
      if (trackedSlot >= 0) {
        const x = reference.horde.x[trackedSlot] ?? 0;
        const y = reference.horde.y[trackedSlot] ?? 0;
        if (hasPrev) {
          travelled += Math.hypot(x - prevX, y - prevY);
        }
        prevX = x;
        prevY = y;
        hasPrev = true;
      }
    }

    process.stdout.write(
      `scenario 10 (mort a retard ${LATE_DELAY} ticks > ROLLBACK_DEPTH_TICKS=${ROLLBACK_DEPTH_TICKS}) : ` +
        `derive residuelle ${maxDrift.toFixed(3)} px\n`,
    );

    expect(reference.horde.count).toBe(ENTITIES - DEATH_IDS.length);
    expect(travelled).toBeGreaterThan(500);

    for (const p of clients) {
      // Signalee : le compteur de morts tardives a bien vu passer les 20 morts
      // trop vieilles pour l'anneau.
      expect(p.lateDeaths).toBe(DEATH_IDS.length);
      // Appliquee quand meme, sans planter : le compte final converge vers
      // celui du serveur malgre l'absence de rejeu pour cette mort-la.
      expect(p.horde.count).toBe(reference.horde.count);
    }

    // La derive residuelle est mesuree et affichee (obligation de la tache 8),
    // pas verrouillee finement : ce chemin de secours n'a jamais pretendu
    // preserver la precision du rejeu, seulement eviter le silence et le crash.
    expect(Number.isFinite(maxDrift)).toBe(true);
    expect(maxDrift).toBeLessThan(2000);
  });
});

/**
 * Taches 18, 19 et 21 : les correctifs (plafond de repulsion, apparition hors
 * mur, sortie de mur) doivent produire le MEME resultat des deux cotes,
 * exactement comme le reste de ce fichier le verifie pour la mort et le
 * rejeu. Un seul scenario, exerçant les comportements en sequence sur DEUX
 * simulations independantes (« le serveur » et « un client »), qui ne
 * partagent rien d'autre que la meme graine de carte et le meme ordre de
 * vague — comme deux processus reels.
 *
 * ⚠️ **Ce que la tache 19 change ici.** Avant elle, `SeparationGrid.apply`
 * etait un appel SEPARE de `Horde.step`, ce qui permettait de mesurer le
 * plafond par une simple difference de position avant/apres CET appel-la.
 * Depuis la tache 19, la repulsion est fondue dans `Horde.step` (recalcul de
 * trajectoire par phase, tache 19) : une difference de position avant/apres
 * `step` mesurerait la direction du champ ET la repulsion ET, pour un
 * entassement artificiel EXACTEMENT co-localise, un artefact du calendrier de
 * phase lui-meme (des entites identiques divergent des qu'elles n'ont pas
 * toutes la meme phase de recalcul — verifie a la main en ecrivant ce test,
 * voir le rapport de la tache 19). Le plafond se verifie donc desormais sur
 * `vx`/`vy` DIRECTEMENT (publics depuis la tache 19).
 *
 * ⚠️ **Ce que la tache 21 change ici.** Le plafond n'est plus la SOMME des
 * deux contributions (`archetypeOf(...).speed + STEERING_REPULSION_STRENGTH`,
 * l'ancienne formule ADDITIVE) : melanger les directions puis ne remettre a
 * l'echelle qu'UNE SEULE fois par la vitesse propre rend cette somme sans
 * objet — la norme de `vx`/`vy` ne peut plus jamais depasser
 * `archetypeOf(...).speed` SEULE, quelle que soit la repulsion. Cette borne
 * etant desormais INTRINSEQUE (voir `shared/horde.test.ts` pour l'unite qui
 * la verifie sur un entassement dedie), la verifier ICI, a l'echelle d'un
 * scenario de replication realiste, est une confirmation supplementaire —
 * pas la seule preuve.
 */
describe('taches 18, 19 et 21 : plafond de repulsion et sortie de mur, verifies identiques sur deux clients', () => {
  function fieldAt(fields: readonly FlowField[], i: number): FlowField {
    const f = fields[i];
    if (!f) {
      throw new Error('champ manquant');
    }
    return f;
  }

  it('deux simulations independantes s accordent sur les trois comportements, tick pour tick', () => {
    const mapSeed = 0x7a58_18ac;
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(mapSeed, probe.cols, probe.rows);

    // Un mur force explicitement a l'ancre de la vague : garantit que
    // l'evitement d'apparition (comportement 2) est reellement exerce, plutot
    // que de dependre du hasard de `generateObstacles` pour cette graine.
    // `mask` est calcule UNE fois puis copie dans chaque participant par
    // `applyObstacles` (comme le fait deja le reste de ce fichier) : c'est
    // fidele a la realite, ou deux cotes qui regenerent independamment la
    // meme graine obtiennent par construction le meme masque (§5.1).
    const anchorCol = 10;
    const anchorRow = 10;
    mask[anchorRow * probe.cols + anchorCol] = 1;
    const anchorX = (anchorCol + 0.5) * FLOWFIELD_CELL;
    const anchorY = (anchorRow + 0.5) * FLOWFIELD_CELL;

    function makeParticipant(): {
      horde: Horde;
      fields: FlowField[];
      history: PlayerHistory;
    } {
      const horde = new Horde(2000);
      const fields = Array.from({ length: 4 }, () => {
        const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
        applyObstacles(f, mask);
        return f;
      });
      return { horde, fields, history: new PlayerHistory() };
    }

    const server = makeParticipant();
    const client = makeParticipant();
    const parts = [server, client];

    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d001,
      archetype: 0,
      formation: FORMATION.CLUSTER,
      anchorX,
      anchorY,
      count: 300,
    };
    for (const p of parts) {
      p.horde.spawn(order, fieldAt(p.fields, 0));
    }

    // --- Comportement 2 : aucune naissance en plein mur, chez les DEUX. ---
    for (const p of parts) {
      const f = fieldAt(p.fields, 0);
      for (let i = 0; i < p.horde.count; i++) {
        expect(f.blocked[f.indexAt(p.horde.x[i] ?? 0, p.horde.y[i] ?? 0)]).toBe(0);
      }
    }

    // Entasse artificiellement 40 entites, IDENTIQUEMENT chez les deux
    // participants, pour exercer le plafond de repulsion (comportement 1)
    // sans dependre du hasard d'une formation. Un LEGER etalement (pas un
    // point unique) : des positions EXACTEMENT identiques ne s'exercent
    // jamais entre elles (`d2 === 0` les ignore par construction, voir
    // `shared/horde.test.ts`) — l'entassement doit rester dense mais distinct.
    const PILE = 40;
    const pileX = anchorX + 1500;
    const pileY = anchorY + 1500;
    for (const p of parts) {
      for (let i = 0; i < PILE; i++) {
        p.horde.x[i] = pileX + (i % 5) * 2;
        p.horde.y[i] = pileY + Math.floor(i / 5) * 2;
      }
    }

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    let maxObservedSpeed = 0;
    let maxCapForSpeed = 0;
    const TICKS = 240;

    for (let tick = 0; tick < TICKS; tick++) {
      const xs = [0, 1, 2, 3].map((pl) => 3000 + Math.cos(tick * 0.02 + pl) * 1500);
      const ys = [0, 1, 2, 3].map((pl) => 3000 + Math.sin(tick * 0.02 + pl) * 1500);

      for (const p of parts) {
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
        p.horde.step(DT, p.fields, tick);

        // Plafond (comportement 1) : verifie directement sur `vx`/`vy`, voir
        // la doc de ce `describe`. Depuis la tache 21, la borne par entite
        // est SA PROPRE vitesse d'archetype, SEULE — plus de terme de
        // repulsion a additionner, quelle que soit la densite autour d'elle.
        for (let i = 0; i < p.horde.count; i++) {
          const cap = archetypeOf(p.horde.archetype[i] ?? 0).speed * 1.0001; // marge flottante minime.
          const speed = Math.hypot(p.horde.vx[i] ?? 0, p.horde.vy[i] ?? 0);
          if (speed > maxObservedSpeed) {
            maxObservedSpeed = speed;
            maxCapForSpeed = cap;
          }
          expect(speed).toBeLessThanOrEqual(cap);
        }
      }

      // --- Comportement 4 : accord tick pour tick entre les deux participants. ---
      // Position ET vitesse tenue (tache 19) : deux clients qui divergeraient
      // sur `vx`/`vy` seuls (vitesse sauvegardee/restauree differemment)
      // divergeraient sur la position au(x) pas suivant(s) — les verifier
      // TOUS LES DEUX rend le defaut visible un pas plus tot.
      expect(client.horde.count).toBe(server.horde.count);
      for (let i = 0; i < server.horde.count; i++) {
        expect(client.horde.x[i]).toBe(server.horde.x[i]);
        expect(client.horde.y[i]).toBe(server.horde.y[i]);
        expect(client.horde.vx[i]).toBe(server.horde.vx[i]);
        expect(client.horde.vy[i]).toBe(server.horde.vy[i]);
      }
    }

    // Depuis la tache 21, cette borne est intrinseque : toute entite dont le
    // champ est non nul l'atteint exactement, entassement ou pas (voir
    // `shared/horde.test.ts` pour la mesure qui isole vraiment l'effet de la
    // densite). Ici, ce n'est plus une preuve que le pic a ete exerce, mais
    // une garantie que le mouvement observe n'est pas degenere a zero.
    expect(maxObservedSpeed).toBeGreaterThan(maxCapForSpeed * 0.5);

    // --- Comportement 3 : sortie de mur, identiquement chez les deux. ---
    for (const p of parts) {
      p.horde.x[0] = anchorX;
      p.horde.y[0] = anchorY;
      p.horde.targetField[0] = 0;
      // Sans ca, une entite reconnue "a portee de contact" lors d'un
      // `retarget` anterieur resterait immobile (tache 17.2) quelle que soit
      // la sortie de mur offerte par le champ — un faux negatif sans rapport
      // avec ce qu'on verifie ici.
      p.horde.stopped[0] = 0;
    }

    let serverEscapeTick = -1;
    let clientEscapeTick = -1;
    for (let t = 0; t < 60; t++) {
      for (const p of parts) {
        p.horde.step(DT, p.fields, TICKS + t);
      }
      const sField = fieldAt(server.fields, server.horde.targetField[0] ?? 0);
      const cField = fieldAt(client.fields, client.horde.targetField[0] ?? 0);
      if (
        serverEscapeTick < 0 &&
        sField.blocked[sField.indexAt(server.horde.x[0] ?? 0, server.horde.y[0] ?? 0)] === 0
      ) {
        serverEscapeTick = t;
      }
      if (
        clientEscapeTick < 0 &&
        cField.blocked[cField.indexAt(client.horde.x[0] ?? 0, client.horde.y[0] ?? 0)] === 0
      ) {
        clientEscapeTick = t;
      }
    }

    process.stdout.write(
      `taches 18/19 : vitesse max observee ${maxObservedSpeed.toFixed(3)} px/s (borne ${maxCapForSpeed.toFixed(3)}), ` +
        `sortie de mur au tick ${serverEscapeTick} (serveur) / ${clientEscapeTick} (client)\n`,
    );

    expect(serverEscapeTick).toBeGreaterThanOrEqual(0);
    expect(serverEscapeTick).toBe(clientEscapeTick);
  });
});

/**
 * Etape 5a, tache 6 — **le ralentissement du Givre, mesure.**
 *
 * C'est le premier effet du projet qui touche le DEPLACEMENT, donc le contrat
 * de replication a 0,000 px que ce fichier tient depuis l'etape 2. Ce bloc
 * reprend, trait pour trait, la structure des scenarios 8 / 9 / 10 ci-dessus
 * — le meme calendrier arithmetique, les memes retards de 1 a 3 ticks, la
 * meme mesure par identite — en remplacant « une mort arrive en retard » par
 * « une zone arrive en retard ».
 *
 * Trois choses y sont verifiees, et il faut les trois :
 *
 * 1. **le ralentissement MORD** (`mordu`) — sans quoi une derive nulle voudrait
 *    dire « rien ne s'est passe » autant que « replication parfaite ». C'est le
 *    piege de la fixture qui masque, cinq fois rencontre dans ce depot : on
 *    COMPTE le cas qu'on croit creer, on ne le suppose pas. Ici, la reference
 *    avec zones est comparee a une reference sans zones ;
 * 2. **sans rejeu, ca derive** (scenario Z1) — le pendant du scenario 8 ;
 * 3. **avec rejeu, ca retombe a zero** (scenario Z2) — le pendant du scenario 9.
 *
 * Et le scenario Z3 mesure ce que coute une zone trop vieille pour l'anneau,
 * comme le scenario 10 le fait pour une mort.
 */
describe('etape 5a tache 6 : le Givre ralentit, et le rejeu le date au tick', () => {
  const WAVE_ID = 1;
  // Memes valeurs et meme raisonnement que `DEATH_START` / `DEATH_INTERVAL`
  // plus haut : 13 n'est pas multiple de `stepsPerField` (3), donc les
  // `bornTick` successifs parcourent les trois restes modulo 3 et un
  // `primeFieldForReplay` qui ne ramenerait pas le tick a `lastDue` echoue sur
  // les deux tiers des lots au lieu de passer inapercu.
  const ZONE_START = 151;
  const ZONE_INTERVAL = 13;
  const ZONE_BATCHES = 18;
  /**
   * Les entites sur lesquelles le serveur pose ses zones. Cinq points epars
   * dans une grappe de mille : chacun couvre des dizaines de voisines, et
   * ensemble ils exercent le minimum de `#computeSlow` (une entite couverte
   * par deux zones a la fois).
   */
  const ANCHORS: readonly number[] = [100, 300, 500, 700, 900];
  const CLIENT_DELAY: readonly number[] = [0, 1, 2, 3, 2];
  const END = ZONE_START + ZONE_BATCHES * ZONE_INTERVAL + 60;

  interface ZoneParticipant {
    horde: Horde;
    fields: FlowField[];
    playerHistory: PlayerHistory;
    hordeHistory: HordeHistory;
    zones: ZoneField;
    /** Zones posees au present faute d'anneau assez profond (scenario Z3). */
    lateZones: number;
  }

  /** Ce que le message `ZONE` transporte (§8 de la spec) — rien de plus. */
  interface ZoneAnnounce {
    kind: number;
    x: number;
    y: number;
    bornTick: number;
    by: number;
  }

  function makeZoneParticipant(mapSeed: number): ZoneParticipant {
    const horde = new Horde(4000);
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
    const fields = Array.from({ length: 4 }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    return {
      horde,
      fields,
      playerHistory: new PlayerHistory(),
      hordeHistory: new HordeHistory(horde.capacity),
      zones: new ZoneField(),
      lateZones: 0,
    };
  }

  /** Derive maximale entre deux hordes, appariee par identite. Aucune mort ici : les creneaux se correspondent, mais on n'en depend pas. */
  function maxDriftBetween(reference: Horde, participant: Horde): number {
    let maxDrift = 0;
    for (let slot = 0; slot < reference.count; slot++) {
      const other = participant.slotOf(reference.entityIdAt(slot));
      if (other < 0) {
        continue;
      }
      const drift = Math.hypot(
        (participant.x[other] ?? 0) - (reference.x[slot] ?? 0),
        (participant.y[other] ?? 0) - (reference.y[slot] ?? 0),
      );
      if (drift > maxDrift) {
        maxDrift = drift;
      }
    }
    return maxDrift;
  }

  function primeFieldForReplay(p: ZoneParticipant, atTick: number, stepsPerField: number): void {
    const lastDue = atTick - (((atTick % stepsPerField) + stepsPerField) % stepsPerField);
    const seen = p.playerHistory.delayed(lastDue);
    if (seen) {
      for (let f = 0; f < 4; f++) {
        p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
      }
    }
  }

  function replayTick(p: ZoneParticipant, tick: number, stepsPerField: number): void {
    if (tick % stepsPerField === 0) {
      const seen = p.playerHistory.delayed(tick);
      if (seen) {
        for (let f = 0; f < 4; f++) {
          p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        p.horde.retarget(seen.x, seen.y);
      }
    }
    p.horde.step(DT, p.fields, tick, p.zones);
    p.hordeHistory.record(tick, p.horde);
  }

  /**
   * Pose une zone annoncee AVEC rejeu : restaure au `bornTick`, pose, rejoue
   * jusqu'au present. Miroir exact de `GameClient#applyZone`.
   */
  function applyZoneWithReplay(
    p: ZoneParticipant,
    zone: ZoneAnnounce,
    currentTick: number,
    stepsPerField: number,
  ): void {
    if (!p.hordeHistory.restore(zone.bornTick, p.horde)) {
      p.lateZones++;
      p.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
      return;
    }
    p.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
    primeFieldForReplay(p, zone.bornTick, stepsPerField);
    for (let t = zone.bornTick + 1; t <= currentTick; t++) {
      replayTick(p, t, stepsPerField);
    }
  }

  interface ZoneScenarioResult {
    reference: Horde;
    clients: ZoneParticipant[];
    maxDrift: number;
    /** Zones effectivement annoncees par la reference — le scenario ne prouve rien a zero. */
    announced: number;
  }

  /**
   * Le scenario commun : cinq participants, mille entites, et un serveur qui
   * pose des zones sur cinq de ses propres entites tous les `ZONE_INTERVAL`
   * ticks. Chaque client l'apprend `delay` ticks plus tard.
   *
   * `withReplay` bascule entre les deux strategies — la SEULE difference entre
   * Z1 et Z2. `delayOverride` sert au scenario Z3 (hors anneau).
   *
   * ⚠️ **`kind` depuis la tache 7 de l'etape 5b, plus seulement un element
   * brut.** `packZoneKind(element, 0) === element` pour tout element sur 3
   * bits (voir le docbloc de `ZoneField.spawn`), donc les scenarios Z0 a Z3
   * qui passent `ELEMENT.GIVRE`/`ELEMENT.NEUTRE` continuent de fonctionner
   * tels quels ; les scenarios ZF passent un `kind` EMPAQUETE
   * (`packZoneKind(element, REACTION.SUPRACONDUCTION)`) pour le gel de la
   * Supraconduction.
   */
  function runZoneScenario(
    mapSeed: number,
    withReplay: boolean,
    kind: number,
    delays: readonly number[] = CLIENT_DELAY,
  ): ZoneScenarioResult {
    const parts = Array.from({ length: PARTICIPANTS }, () => makeZoneParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }
    const clients = parts.slice(1);

    const order: WaveOrder = {
      waveId: WAVE_ID,
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

    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const announced: ZoneAnnounce[] = [];
    let maxDrift = 0;
    // Vrai tant qu'un client n'a pas encore recu une zone que le serveur a
    // deja posee : pendant ce transit, il n'est PAS ralenti alors que le
    // serveur l'est, et cet ecart est du au reseau, pas a la qualite de la
    // correction. Meme masque que `pendingDeath` des scenarios 8 et 9.
    const pendingZone: boolean[] = clients.map(() => false);

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((pl) => 3000 + Math.cos(tick * 0.02 + pl) * 1500);
      const ys = [0, 1, 2, 3].map((pl) => 3000 + Math.sin(tick * 0.02 + pl) * 1500);

      for (const p of parts) {
        p.playerHistory.record(tick, xs, ys);
        if (tick % stepsPerField === 0) {
          const seen = p.playerHistory.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }
        // Le serveur expire a l'heure ; un client garde ses zones mortes
        // `ROLLBACK_DEPTH_TICKS` ticks de plus pour pouvoir rejouer — voir
        // `ZoneField.aliveAt`. Les deux repondent la meme chose parce que les
        // deux passent par le meme predicat, jamais par la presence dans le
        // tableau.
        p.zones.expire(p === reference ? tick : tick - ROLLBACK_DEPTH_TICKS);
        p.horde.step(DT, p.fields, tick, p.zones);
      }

      // Le serveur pose APRES avoir fait avancer sa horde — l'ordre de
      // `Room.step`, et la raison pour laquelle une zone ne ralentit qu'a
      // partir du tick suivant (`ZoneField.slowsAt`).
      if (tick >= ZONE_START && (tick - ZONE_START) % ZONE_INTERVAL === 0) {
        let posed = false;
        for (const idx of ANCHORS) {
          const slot = reference.horde.slotOf(entityIdOf(WAVE_ID, idx));
          if (slot < 0) {
            continue;
          }
          // Arrondies, comme sur le fil : `encodeZone` ne transporte que des
          // `int16`, et le serveur s'impose l'arrondi qu'il inflige au client
          // (meme discipline que les positions de joueurs, constat C1.4).
          reference.zones.spawn(
            kind,
            Math.round(reference.horde.x[slot] ?? 0),
            Math.round(reference.horde.y[slot] ?? 0),
            0,
            tick,
          );
          posed = true;
        }
        if (posed) {
          // `bornTick === tick` EST la trace de la pose, creation comme
          // rafraichissement — voir `Room#announceZones`.
          for (let z = 0; z < reference.zones.count; z++) {
            if (reference.zones.bornTick[z] !== tick) {
              continue;
            }
            announced.push({
              kind: reference.zones.kind[z] ?? 0,
              x: reference.zones.x[z] ?? 0,
              y: reference.zones.y[z] ?? 0,
              bornTick: tick,
              by: reference.zones.by[z] ?? 0,
            });
            pendingZone.fill(true);
          }
        }
      }

      clients.forEach((p, i) => {
        p.hordeHistory.record(tick, p.horde);
        const delay = delays[i + 1] ?? 0;
        for (const zone of announced) {
          if (zone.bornTick + delay !== tick) {
            continue;
          }
          if (withReplay) {
            applyZoneWithReplay(p, zone, tick, stepsPerField);
          } else {
            // Sans rejeu : la zone est posee au present, avec son `bornTick`
            // d'origine. C'est le defaut que le rejeu corrige.
            p.zones.spawn(zone.kind, zone.x, zone.y, zone.by, zone.bornTick);
          }
          pendingZone[i] = false;
        }
      });

      clients.forEach((p, i) => {
        if (pendingZone[i]) {
          return;
        }
        const drift = maxDriftBetween(reference.horde, p.horde);
        if (drift > maxDrift) {
          maxDrift = drift;
        }
      });
    }

    return { reference: reference.horde, clients, maxDrift, announced: announced.length };
  }

  /**
   * De combien la reference a-t-elle ete freinee ? Compare la meme run avec du
   * Givre et avec du Neutre — meme graine, meme calendrier, meme geometrie de
   * zones, seul `slowFactor` change.
   *
   * ⚠️ **C'est la garde anti-fixture.** Sans elle, « 0,000 px » ne
   * distinguerait pas un rejeu exact d'un ralentissement qui ne s'applique a
   * personne.
   */
  function freinage(mapSeed: number): number {
    const givre = runZoneScenario(mapSeed, true, ELEMENT.GIVRE).reference;
    const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
    return maxDriftBetween(temoin, givre);
  }

  it('scenario Z0 — le ralentissement mord reellement : la horde givree decroche du temoin neutre', () => {
    const mordu = freinage(0x21e5_0000);
    process.stdout.write(
      `scenario Z0 (le Givre mord) : ecart maximal entre horde givree et temoin neutre ${mordu.toFixed(3)} px\n`,
    );
    // Derivee de la constante, jamais recopiee : sur `ZONE_LIFETIME_TICKS`
    // ticks de couverture, une entite de la vitesse la plus lente du bestiaire
    // perd au moins `(1 - slowFactor)` de son avance. Un dixieme de ce total
    // suffit largement a distinguer « ca mord » de « ca ne mord pas », et
    // laisse toute latitude aux entites qui entrent et sortent des disques.
    const attenduMin =
      0.1 *
      (1 - elementOf(ELEMENT.GIVRE).slowFactor) *
      archetypeOf(0).speed *
      (ZONE_LIFETIME_TICKS / TICK_HZ);
    expect(mordu).toBeGreaterThan(attenduMin);
  });

  it('scenario Z1 — sans rejeu, une zone appliquee au present laisse une derive mesurable', () => {
    const result = runZoneScenario(0x21e5_0001, false, ELEMENT.GIVRE);
    process.stdout.write(
      `scenario Z1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
        `${result.announced} zones annoncees\n`,
    );
    // Le scenario ne prouve rien si rien n'a ete annonce.
    expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
    // Borne large et volontaire, comme au scenario 8 : ce scenario existe pour
    // que la derive EXISTE, pas pour qu'elle reste petite.
    expect(result.maxDrift).toBeGreaterThan(1);
  });

  it('scenario Z2 — avec rejeu, la derive retombe a zero malgre le Givre', () => {
    const result = runZoneScenario(0x21e5_0002, true, ELEMENT.GIVRE);
    process.stdout.write(
      `scenario Z2 (avec rejeu, Givre en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
        `${result.announced} zones annoncees\n`,
    );
    expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
    for (const p of result.clients) {
      // 1 a 3 ticks de retard tiennent largement dans l'anneau.
      expect(p.lateZones).toBe(0);
      expect(p.horde.count).toBe(result.reference.count);
    }
    expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
  });

  it('scenario Z3 — une zone trop vieille pour l anneau est posee au present, signalee, et sa derive residuelle mesuree', () => {
    const LATE_DELAY = ROLLBACK_DEPTH_TICKS + 4;
    // Le retard doit vraiment sortir de l'anneau, sinon ce scenario mesure la
    // meme chose que Z2 et ne prouve rien.
    expect(LATE_DELAY).toBeGreaterThan(ROLLBACK_DEPTH_TICKS);
    const result = runZoneScenario(0x21e5_0003, true, ELEMENT.GIVRE, [
      0,
      LATE_DELAY,
      LATE_DELAY,
      LATE_DELAY,
      LATE_DELAY,
    ]);
    const lateZones = result.clients.reduce((sum, p) => sum + p.lateZones, 0);
    process.stdout.write(
      `scenario Z3 (zone a retard ${LATE_DELAY} ticks > ROLLBACK_DEPTH_TICKS=${ROLLBACK_DEPTH_TICKS}) : ` +
        `derive residuelle ${result.maxDrift.toFixed(3)} px, lateZones=${lateZones}\n`,
    );
    // La degradation est ASSUMEE, mais jamais silencieuse : elle se compte.
    expect(lateZones).toBeGreaterThan(0);
    expect(result.maxDrift).toBeGreaterThan(0);
  });

  /**
   * La Supraconduction (Givre + Foudre, tache 7 de l'etape 5b) : `slowFactor:
   * 0`, la PREMIERE reaction de l'etape a toucher le deplacement — le
   * contrat que ce fichier protege depuis l'etape 2. Meme decor que les
   * scenarios Z0 a Z2 ci-dessus, REUTILISE via `runZoneScenario` — un `kind`
   * empaquete (`packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION)`) au
   * lieu d'un element brut, rien de plus.
   *
   * ⚠️ **Les trois memes preuves que Z0 a Z2, dans le meme ordre, et il faut
   * les trois** : ZF0 prouve que le gel MORD (sans quoi 0,000 px au ZF2 ne
   * prouverait rien), ZF1 prouve que sans rejeu ca derive reellement (le
   * zero de ZF2 mesure alors quelque chose), ZF2 est le test qui compte —
   * avec rejeu, la derive retombe a (quasi) zero malgre le gel total.
   */
  describe('etape 5b tache 7 : la Supraconduction fige, et le rejeu la date au tick', () => {
    const SUPRA_KIND = packZoneKind(ELEMENT.GIVRE, REACTION.SUPRACONDUCTION);

    /**
     * De combien la reference a-t-elle ete figee ? Compare la meme run avec
     * de la Supraconduction et avec du Neutre — meme graine, meme
     * calendrier, meme geometrie de zones, seul le `kind` change. Meme garde
     * anti-fixture que `freinage` ci-dessus : sans elle, « 0,000 px » au ZF2
     * ne distinguerait pas un rejeu exact d'un gel qui ne s'applique a
     * personne.
     */
    function gelage(mapSeed: number): number {
      const supra = runZoneScenario(mapSeed, true, SUPRA_KIND).reference;
      const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
      return maxDriftBetween(temoin, supra);
    }

    it('scenario ZF0 — le gel mord reellement : la horde figee decroche du temoin neutre', () => {
      const mordu = gelage(0x5fee_0000);
      process.stdout.write(
        `scenario ZF0 (la Supraconduction mord) : ecart maximal entre horde figee et temoin neutre ${mordu.toFixed(3)} px\n`,
      );
      // ⚠️ **Gel TOTAL (`slowFactor` 0), pas un simple ralentissement comme
      // le Givre de Z0** : une entite couverte n'avance plus DU TOUT tant
      // que la zone vit, la ou le temoin continue tout du long. Le seuil
      // attendu est donc le trajet ENTIER d'une entite a la vitesse la plus
      // lente du bestiaire sur `ZONE_LIFETIME_TICKS`, pas seulement
      // `(1 - slowFactor)` de cette avance (voir le calcul de Z0). Un
      // dixieme de ce total suffit a distinguer « ca gele » de « ca ne gele
      // pas », meme avec des entites qui entrent et sortent des disques.
      const attenduMin = 0.1 * archetypeOf(0).speed * (ZONE_LIFETIME_TICKS / TICK_HZ);
      expect(mordu).toBeGreaterThan(attenduMin);
    });

    it('scenario ZF1 — sans rejeu, une zone de Supraconduction appliquee au present laisse une derive mesurable', () => {
      const result = runZoneScenario(0x5fee_0001, false, SUPRA_KIND);
      process.stdout.write(
        `scenario ZF1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      // Borne large et volontaire, comme au scenario Z1 : ce scenario existe
      // pour que la derive EXISTE, pas pour qu'elle reste petite — c'est le
      // chiffre non nul a cote duquel le zero de ZF2 prend son sens (§2 des
      // resultats de la tache 6a, la lecon des deux lignes non nulles).
      expect(result.maxDrift).toBeGreaterThan(1);
    });

    it('scenario ZF2 — avec rejeu, la derive retombe a (quasi) zero malgre le gel total : le test qui compte', () => {
      const result = runZoneScenario(0x5fee_0002, true, SUPRA_KIND);
      process.stdout.write(
        `scenario ZF2 (avec rejeu, Supraconduction en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      for (const p of result.clients) {
        // 1 a 3 ticks de retard tiennent largement dans l'anneau.
        expect(p.lateZones).toBe(0);
        expect(p.horde.count).toBe(result.reference.count);
      }
      expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
    });
  });

  /**
   * Verglas (Givre + Poix, tache 8 de l'etape 5b) : « les ennemis
   * derapent ». Meme decor que Z0 a Z2 et ZF0 a ZF2 ci-dessus, REUTILISE via
   * `runZoneScenario` — un `kind` empaquete
   * (`packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS)`), rien de plus.
   *
   * ⚠️ **C'est le test que le brief de la tache 8 exige AVANT toute
   * implementation** : « Verglas en jeu, avec rejeu, 0,000 px — et sans
   * rejeu, un chiffre non nul ». `runZoneScenario` porte deja les DEUX
   * moities de la mesure ; VF0 et VF1 sont les chiffres non nuls a cote
   * desquels le zero de VF2 prend son sens (§2 des resultats de la tache
   * 6a, la lecon des deux lignes non nulles — et la regle rappelee par le
   * brief de cette tache : « une mesure qui ne sait produire que 0,000 px
   * ne mesure pas »).
   *
   * ⚠️ **Ce scenario mesure les DEUX moities de `Horde#recomputeSteering`
   * a la fois : la vitesse tenue amortie ET le `zoneSlowFactor` epingle au
   * Givre.** Il ne cherche pas a les separer — c'est `horde.test.ts` qui
   * isole chaque mecanisme a l'unite (voir « Horde.step — Verglas fait
   * deraper la horde »). Ici, l'enjeu est uniquement la REPLICATION du
   * resultat compose, avec et sans rejeu.
   */
  describe('etape 5b tache 8 : Verglas fait deraper la horde, et le rejeu la date au tick', () => {
    const VERGLAS_KIND = packZoneKind(ELEMENT.GIVRE, REACTION.VERGLAS);

    /**
     * De combien la reference a-t-elle derape ? Compare la meme run avec du
     * Verglas et avec du Neutre — meme graine, meme calendrier, meme
     * geometrie de zones, seul le `kind` change. Meme garde anti-fixture que
     * `freinage`/`gelage` : sans elle, « 0,000 px » au VF2 ne distinguerait
     * pas un rejeu exact d'un derapage qui ne s'applique a personne.
     */
    function derapage(mapSeed: number): number {
      const verglas = runZoneScenario(mapSeed, true, VERGLAS_KIND).reference;
      const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
      return maxDriftBetween(temoin, verglas);
    }

    it('scenario VF0 — Verglas mord reellement : la horde derapee decroche du temoin neutre', () => {
      const mordu = derapage(0x7e6a_0000);
      process.stdout.write(
        `scenario VF0 (Verglas mord) : ecart maximal entre horde derapee et temoin neutre ${mordu.toFixed(3)} px\n`,
      );
      // ⚠️ **Une BORNE BASSE, pas la mesure complete.** `zoneSlowFactor` de
      // Verglas est EXPLICITEMENT epingle au facteur du Givre (voir
      // `shared/reactions.ts`, R13) : quel que soit l'ordre d'arrivee, une
      // horde derapee est AU MOINS aussi freinee qu'une horde givree — et le
      // derapage lui-meme (la perte de correction de trajectoire, en plus
      // du ralentissement) ne peut qu'AJOUTER de l'ecart au temoin neutre,
      // jamais en retirer. Le seuil de Z0 reste donc une borne basse valide
      // ici, meme s'il ne mesure que la moitie de l'effet compose.
      const attenduMin =
        0.1 *
        (1 - elementOf(ELEMENT.GIVRE).slowFactor) *
        archetypeOf(0).speed *
        (ZONE_LIFETIME_TICKS / TICK_HZ);
      expect(mordu).toBeGreaterThan(attenduMin);
    });

    it('scenario VF1 — sans rejeu, une zone de Verglas appliquee au present laisse une derive mesurable', () => {
      const result = runZoneScenario(0x7e6a_0001, false, VERGLAS_KIND);
      process.stdout.write(
        `scenario VF1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      // Le scenario ne prouve rien si rien n'a ete annonce.
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      // Borne large et volontaire, comme aux scenarios Z1/ZF1 : ce scenario
      // existe pour que la derive EXISTE, pas pour qu'elle reste petite.
      expect(result.maxDrift).toBeGreaterThan(1);
    });

    it('scenario VF2 — avec rejeu, la derive retombe a (quasi) zero malgre le derapage : le test qui compte', () => {
      const result = runZoneScenario(0x7e6a_0002, true, VERGLAS_KIND);
      process.stdout.write(
        `scenario VF2 (avec rejeu, Verglas en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      for (const p of result.clients) {
        // 1 a 3 ticks de retard tiennent largement dans l'anneau.
        expect(p.lateZones).toBe(0);
        expect(p.horde.count).toBe(result.reference.count);
      }
      expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
    });
  });

  /**
   * La Chaux (tache 1 de l'etape 5c) : « il fuit » — la direction du champ
   * s'inverse pour un ennemi en zone, une SUBSTITUTION au moment ou
   * `Horde#recomputeSteering` lit `fx`/`fy`, jamais une ecriture dans
   * `targetField` (voir le docbloc de `Horde#computeFieldSign`). Meme decor
   * que Z0 a Z2 et ZF0 a ZF2 ci-dessus, REUTILISE via `runZoneScenario` —
   * `packZoneKind(element, 0) === element`, donc `ELEMENT.CHAUX` seul est
   * deja un `kind` valide (voir le docbloc de `ZoneField.spawn`) : aucune
   * reaction nommee ne pair encore la Chaux (taches 4 a 7 de l'etape 5c,
   * hors perimetre), c'est l'element SEUL qui porte la fuite ici.
   *
   * ⚠️ **Les trois memes preuves que Z0 a Z2 et ZF0 a ZF2, dans le meme
   * ordre, et il faut les trois** : CF0 prouve que la fuite MORD (sans quoi
   * 0,000 px au CF2 ne prouverait rien), CF1 prouve que sans rejeu ca derive
   * reellement (le zero de CF2 mesure alors quelque chose), CF2 est le test
   * qui compte — avec rejeu, la derive retombe a (quasi) zero malgre
   * l'inversion de direction.
   */
  describe('etape 5c tache 1 : la Chaux fait fuir, et le rejeu la date au tick', () => {
    const CHAUX_KIND = ELEMENT.CHAUX;

    /**
     * De combien la reference a-t-elle fui ? Compare la meme run avec de la
     * Chaux et avec du Neutre — meme graine, meme calendrier, meme
     * geometrie de zones, seul le `kind` change. Meme garde anti-fixture que
     * `freinage`/`gelage`/`derapage` : sans elle, « 0,000 px » au CF2 ne
     * distinguerait pas un rejeu exact d'une fuite qui ne s'applique a
     * personne.
     */
    function fuite(mapSeed: number): number {
      const chaux = runZoneScenario(mapSeed, true, CHAUX_KIND).reference;
      const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
      return maxDriftBetween(temoin, chaux);
    }

    it('scenario CF0 — la fuite mord reellement : la horde chaulee decroche du temoin neutre', () => {
      const mordu = fuite(0xc4a0_0000);
      process.stdout.write(
        `scenario CF0 (la Chaux mord) : ecart maximal entre horde chaulee et temoin neutre ${mordu.toFixed(3)} px\n`,
      );
      // ⚠️ **Une INVERSION de direction, pas un ralentissement comme le
      // Givre de Z0 ni un gel comme la Supraconduction de ZF0** : une entite
      // fuyante s'eloigne du joueur a PLEINE vitesse la ou le temoin
      // s'en approche a la meme vitesse — les deux trajectoires divergent
      // donc au moins aussi vite que le gel total fait decrocher le temoin
      // de ZF0 (qui, lui, reste immobile pendant que le temoin avance). Le
      // meme seuil, un dixieme du trajet ENTIER d'une entite a la vitesse la
      // plus lente du bestiaire sur `ZONE_LIFETIME_TICKS`, reste donc une
      // borne basse valide ici, meme avec des entites qui entrent et
      // sortent des disques et un recalcul de trajectoire qui n'a lieu
      // qu'une fois sur `STEERING_RECOMPUTE_TICKS`.
      const attenduMin = 0.1 * archetypeOf(0).speed * (ZONE_LIFETIME_TICKS / TICK_HZ);
      expect(mordu).toBeGreaterThan(attenduMin);
    });

    it('scenario CF1 — sans rejeu, une zone de Chaux appliquee au present laisse une derive mesurable', () => {
      const result = runZoneScenario(0xc4a0_0001, false, CHAUX_KIND);
      process.stdout.write(
        `scenario CF1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      // Borne large et volontaire, comme aux scenarios Z1/ZF1/VF1 : ce
      // scenario existe pour que la derive EXISTE, pas pour qu'elle reste
      // petite.
      expect(result.maxDrift).toBeGreaterThan(1);
    });

    it('scenario CF2 — avec rejeu, la derive retombe a (quasi) zero malgre la fuite : le test qui compte', () => {
      const result = runZoneScenario(0xc4a0_0002, true, CHAUX_KIND);
      process.stdout.write(
        `scenario CF2 (avec rejeu, Chaux en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      for (const p of result.clients) {
        // 1 a 3 ticks de retard tiennent largement dans l'anneau.
        expect(p.lateZones).toBe(0);
        expect(p.horde.count).toBe(result.reference.count);
      }
      expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
    });
  });

  /**
   * Gel profond (Givre + Vif-argent, tache 6 de l'etape 5c) : `slowFactor:
   * 0`, EXACTEMENT comme la Supraconduction (ZF0 a ZF2 ci-dessus) — seule sa
   * duree change (`SURCHAUFFE_ZONE_LIFETIME_TICKS`, reutilisee, voir
   * `REACTION_DEFS`). Meme decor, REUTILISE via `runZoneScenario` : un
   * `kind` empaquete different, rien de plus.
   *
   * ⚠️ **Les trois memes preuves que Z0 a Z2 et ZF0 a ZF2, dans le meme
   * ordre, et il faut les trois** : GF0 prouve que le gel MORD, GF1 prouve
   * que sans rejeu ca derive reellement, GF2 est le test qui compte —
   * avec rejeu, la derive retombe a (quasi) zero malgre le gel total.
   *
   * ⚠️ **Le seuil de GF0 derive de `zoneLifetimeTicks(kind)`, PAS de
   * `ZONE_LIFETIME_TICKS`** — contrairement a ZF0, dont la Supraconduction
   * vit la duree GENERIQUE. Gel profond vit plus longtemps
   * (`SURCHAUFFE_ZONE_LIFETIME_TICKS`) : reprendre la constante generique
   * ici sous-estimerait le seuil sans le faire rougir, un decor qui masque.
   */
  describe('etape 5c tache 6 : Gel profond fige, plus longtemps que la Supraconduction, et le rejeu le date au tick', () => {
    const GEL_PROFOND_KIND = packZoneKind(ELEMENT.GIVRE, REACTION.GEL_PROFOND);

    function gelage(mapSeed: number): number {
      const gel = runZoneScenario(mapSeed, true, GEL_PROFOND_KIND).reference;
      const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
      return maxDriftBetween(temoin, gel);
    }

    it('scenario GF0 — le gel mord reellement : la horde figee decroche du temoin neutre', () => {
      const mordu = gelage(0x6f0_0000);
      process.stdout.write(
        `scenario GF0 (Gel profond mord) : ecart maximal entre horde figee et temoin neutre ${mordu.toFixed(3)} px\n`,
      );
      const attenduMin =
        0.1 * archetypeOf(0).speed * (zoneLifetimeTicks(GEL_PROFOND_KIND) / TICK_HZ);
      expect(mordu).toBeGreaterThan(attenduMin);
    });

    it('scenario GF1 — sans rejeu, une zone de Gel profond appliquee au present laisse une derive mesurable', () => {
      const result = runZoneScenario(0x6f0_0001, false, GEL_PROFOND_KIND);
      process.stdout.write(
        `scenario GF1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      expect(result.maxDrift).toBeGreaterThan(1);
    });

    it('scenario GF2 — avec rejeu, la derive retombe a (quasi) zero malgre le gel total : le test qui compte', () => {
      const result = runZoneScenario(0x6f0_0002, true, GEL_PROFOND_KIND);
      process.stdout.write(
        `scenario GF2 (avec rejeu, Gel profond en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      for (const p of result.clients) {
        expect(p.lateZones).toBe(0);
        expect(p.horde.count).toBe(result.reference.count);
      }
      expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
    });
  });

  /**
   * Mortier vif (Poix + Chaux, tache 6 de l'etape 5c) : `slowFactor: 0`,
   * duree GENERIQUE (contrairement a Gel profond et Aveuglement). Meme
   * decor, REUTILISE via `runZoneScenario`.
   *
   * ⚠️ **Les trois memes preuves, dans le meme ordre** : MV0 prouve que le
   * gel MORD, MV1 prouve que sans rejeu ca derive reellement, MV2 est le
   * test qui compte.
   */
  describe('etape 5c tache 6 : Mortier vif fige, et le rejeu le date au tick', () => {
    const MORTIER_VIF_KIND = packZoneKind(ELEMENT.POIX, REACTION.MORTIER_VIF);

    function scellage(mapSeed: number): number {
      const scelle = runZoneScenario(mapSeed, true, MORTIER_VIF_KIND).reference;
      const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
      return maxDriftBetween(temoin, scelle);
    }

    it('scenario MV0 — le scellement mord reellement : la horde figee decroche du temoin neutre', () => {
      const mordu = scellage(0x4710_0000);
      process.stdout.write(
        `scenario MV0 (Mortier vif mord) : ecart maximal entre horde figee et temoin neutre ${mordu.toFixed(3)} px\n`,
      );
      const attenduMin =
        0.1 * archetypeOf(0).speed * (zoneLifetimeTicks(MORTIER_VIF_KIND) / TICK_HZ);
      expect(mordu).toBeGreaterThan(attenduMin);
    });

    it('scenario MV1 — sans rejeu, une zone de Mortier vif appliquee au present laisse une derive mesurable', () => {
      const result = runZoneScenario(0x4710_0001, false, MORTIER_VIF_KIND);
      process.stdout.write(
        `scenario MV1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      expect(result.maxDrift).toBeGreaterThan(1);
    });

    it('scenario MV2 — avec rejeu, la derive retombe a (quasi) zero malgre le scellement : le test qui compte', () => {
      const result = runZoneScenario(0x4710_0002, true, MORTIER_VIF_KIND);
      process.stdout.write(
        `scenario MV2 (avec rejeu, Mortier vif en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      for (const p of result.clients) {
        expect(p.lateZones).toBe(0);
        expect(p.horde.count).toBe(result.reference.count);
      }
      expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
    });
  });

  /**
   * Aveuglement (Chaux + Vif-argent, tache 6 de l'etape 5c) : « la fuite,
   * plus longue que la Chaux seule » — meme mecanisme que le bloc Chaux
   * (CF0 a CF2 ci-dessus), seule la duree change
   * (`SURCHAUFFE_ZONE_LIFETIME_TICKS`, reutilisee). Meme decor, REUTILISE
   * via `runZoneScenario`.
   *
   * ⚠️ **Le seuil d'AV0 derive de `zoneLifetimeTicks(kind)`, PAS de
   * `ZONE_LIFETIME_TICKS`** — meme garde que GF0 : Aveuglement vit plus
   * longtemps qu'une Chaux seule.
   */
  describe('etape 5c tache 6 : Aveuglement fait fuir, plus longtemps que la Chaux seule, et le rejeu le date au tick', () => {
    const AVEUGLEMENT_KIND = packZoneKind(ELEMENT.VIF_ARGENT, REACTION.AVEUGLEMENT);

    function fuite(mapSeed: number): number {
      const aveugle = runZoneScenario(mapSeed, true, AVEUGLEMENT_KIND).reference;
      const temoin = runZoneScenario(mapSeed, true, ELEMENT.NEUTRE).reference;
      return maxDriftBetween(temoin, aveugle);
    }

    it('scenario AV0 — la fuite mord reellement : la horde aveuglee decroche du temoin neutre', () => {
      const mordu = fuite(0xa7e_0000);
      process.stdout.write(
        `scenario AV0 (Aveuglement mord) : ecart maximal entre horde aveuglee et temoin neutre ${mordu.toFixed(3)} px\n`,
      );
      const attenduMin =
        0.1 * archetypeOf(0).speed * (zoneLifetimeTicks(AVEUGLEMENT_KIND) / TICK_HZ);
      expect(mordu).toBeGreaterThan(attenduMin);
    });

    it('scenario AV1 — sans rejeu, une zone d Aveuglement appliquee au present laisse une derive mesurable', () => {
      const result = runZoneScenario(0xa7e_0001, false, AVEUGLEMENT_KIND);
      process.stdout.write(
        `scenario AV1 (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      expect(result.maxDrift).toBeGreaterThan(1);
    });

    it('scenario AV2 — avec rejeu, la derive retombe a (quasi) zero malgre la fuite : le test qui compte', () => {
      const result = runZoneScenario(0xa7e_0002, true, AVEUGLEMENT_KIND);
      process.stdout.write(
        `scenario AV2 (avec rejeu, Aveuglement en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
          `${result.announced} zones annoncees\n`,
      );
      expect(result.announced).toBeGreaterThan(ZONE_BATCHES);
      for (const p of result.clients) {
        expect(p.lateZones).toBe(0);
        expect(p.horde.count).toBe(result.reference.count);
      }
      expect(result.maxDrift).toBeLessThan(DRIFT_LIMIT_PX);
    });
  });
});

/**
 * ⚠️ **LA QUESTION OUVERTE DE LA TACHE 2, MESUREE PLUTOT QUE SUPPOSEE.**
 *
 * Le plan de l'etape 6a la nomme dans son auto-relecture : les PV de depart se
 * derivent de l'archetype, qui voyage dans l'ordre de vague de 19 octets. Si le
 * serveur multiplie par `hpScale(k)` et que le client ne connait pas `k`, *« les
 * deux cotes n'ont pas les memes PV — et le client tue des monstres que le
 * serveur garde »*.
 *
 * **La reponse tenue ici : le client ne tue rien.** `Horde.hp` n'est lu que par
 * le serveur (sa propre documentation le dit depuis l'etape 5a) ; le client
 * apprend qui meurt par `DEATHS`, depuis l'etape 3. Une divergence de PV n'est
 * donc pas une divergence de simulation — c'est une donnee que l'un des deux
 * cotes n'utilise pas.
 *
 * Ce bloc le MESURE, avec le meme juge que le ralentissement du Givre a
 * l'etape 5a : les deux moities y sont, la seconde etant celle qui empeche la
 * premiere de passer pour rien.
 */
describe("etape 6a : l'echelle de PV du palier ne traverse pas le fil", () => {
  /** Palier de mesure. 5, comme la colonne de la table du §3 de la spec. */
  const PALIER = 5;
  /** Un archetype de pietaille LOURDE : la legere mourrait du premier coup, quelle que soit l'echelle. */
  const ARCHETYPE_LOURD = 1;
  const ENTITES = 120;
  /** Pas de simulation entre deux salves. */
  const PAS_PAR_SALVE = 25;
  const SALVES = 8;

  /**
   * Un scenario complet : cinq participants, le PREMIER etant le serveur.
   *
   * Seul le serveur met ses PV a l'echelle, seul il les soustrait, et seul il
   * decide qui meurt — les quatre clients appliquent le lot d'identites qu'il
   * leur envoie, exactement comme `GameClient` le fait de `DEATHS`.
   */
  function scenario(echelleServeur: number): {
    stats: DriftStats;
    premiereSalveMortelle: number;
    morts: number;
  } {
    const mapSeed = 0x6a11_e42b;
    const parts = Array.from({ length: PARTICIPANTS }, () => makeParticipant(mapSeed));
    const order: WaveOrder = {
      waveId: 1,
      spawnTick: 0,
      seed: 0x51ee_d006,
      archetype: ARCHETYPE_LOURD,
      formation: FORMATION.CLUSTER,
      anchorX: 1200,
      anchorY: 1200,
      count: ENTITES,
    };
    for (const p of parts) {
      p.horde.spawn(order);
    }

    const serveur = parts[0];
    if (!serveur) {
      throw new Error('aucun serveur');
    }
    // ⚠️ Le serveur, et lui seul. Les clients gardent les PV bruts de
    // l'archetype — c'est tout le sujet de ce bloc.
    //
    // ⚠️ **`ARCHETYPE_LOURD`, et ce n'est pas indifferent depuis la tache 3.**
    // Le salon n'applique plus `hpScale` a travers `palierHp`, qui EXEMPTE la
    // pietaille legere : avec un archetype leger, `echelleServeur` vaudrait 1
    // quoi qu'on lui passe et ce bloc mesurerait une derive nulle « parce que
    // rien n'a change » — exactement le temoin degenere que le test suivant
    // existe pour ecarter. Sur un lourd, l'echelle passee ici EST celle que le
    // salon applique.
    for (let i = 0; i < serveur.horde.count; i++) {
      serveur.horde.hp[i] = (serveur.horde.hp[i] ?? 0) * echelleServeur;
    }

    // Degats par salve : assez pour que la pietaille lourde tombe en quelques
    // salves a l'echelle 1, pas assez pour qu'elle tombe aussi vite a l'echelle
    // du palier 5. C'est ce qui rend les deux scenarios distinguables.
    const degats = archetypeOf(ARCHETYPE_LOURD).hp / 3;

    const stats: DriftStats = { maxDrift: 0, identityMismatches: 0 };
    let premiereSalveMortelle = -1;
    let morts = 0;

    for (let salve = 0; salve < SALVES; salve++) {
      advance(parts, salve * PAS_PAR_SALVE, (salve + 1) * PAS_PAR_SALVE, stats);

      const ids: number[] = [];
      for (let i = 0; i < serveur.horde.count; i++) {
        const reste = (serveur.horde.hp[i] ?? 0) - degats;
        serveur.horde.hp[i] = reste;
        if (reste <= 0) {
          ids.push(serveur.horde.entityIdAt(i));
        }
      }
      if (ids.length > 0) {
        if (premiereSalveMortelle < 0) {
          premiereSalveMortelle = salve;
        }
        morts += ids.length;
        // Le serveur applique SA decision, puis la diffuse. Les clients ne
        // consultent jamais leurs propres PV.
        for (const p of parts) {
          p.horde.kill(ids);
        }
      }
    }

    return { stats, premiereSalveMortelle, morts };
  }

  /**
   * Memoise : les deux tests ci-dessous lisent les MEMES deux scenarios, et les
   * rejouer coute cinq simulations completes a chaque fois.
   */
  const cache = new Map<number, ReturnType<typeof scenario>>();
  function scenarioMemo(echelle: number): ReturnType<typeof scenario> {
    const deja = cache.get(echelle);
    if (deja) {
      return deja;
    }
    const frais = scenario(echelle);
    cache.set(echelle, frais);
    return frais;
  }

  it('mesure la derive quand le serveur seul applique hpScale : elle est nulle', () => {
    const { stats, morts } = scenarioMemo(hpScale(PALIER));

    process.stdout.write(
      `etape 6a (hpScale(${PALIER}) cote serveur seul) : derive maximale ` +
        `${stats.maxDrift.toFixed(3)} px, ${morts} morts diffusees\n`,
    );

    // ⚠️ Le decor doit produire ce qu'il mesure : sans mort, aucune compaction
    // de creneaux, et la mesure ne dirait rien du cas qui inquiete le plan.
    expect(morts).toBeGreaterThan(0);
    expect(stats.identityMismatches).toBe(0);
    // Exactement zero, pas « sous le seuil » : les cinq participants executent
    // le meme code sur les memes entrees, et `hp` n'entre dans aucune d'elles.
    expect(stats.maxDrift).toBe(0);
  });

  it('le serveur garde bien ses monstres plus longtemps — sans quoi la mesure ci-dessus ne prouverait rien', () => {
    // ⚠️ **La seconde moitie.** Le test precedent passerait a l'identique avec
    // `hpScale` rendant 1 partout : la derive serait nulle parce que RIEN
    // n'aurait change. Il faut donc montrer que l'echelle a bel et bien modifie
    // ce que le serveur decide — c'est exactement le desaccord que le plan
    // craignait, mesure ici, et qui reste sans effet observable.
    const sans = scenarioMemo(1);
    const avec = scenarioMemo(hpScale(PALIER));

    process.stdout.write(
      `etape 6a : premiere salve mortelle sans echelle = ${sans.premiereSalveMortelle}, ` +
        `au palier ${PALIER} = ${avec.premiereSalveMortelle}\n`,
    );

    expect(sans.premiereSalveMortelle).toBeGreaterThanOrEqual(0);
    expect(avec.premiereSalveMortelle).toBeGreaterThan(sans.premiereSalveMortelle);
    // Et la derive reste nulle des DEUX cotes de la comparaison.
    expect(sans.stats.maxDrift).toBe(0);
    expect(avec.stats.maxDrift).toBe(0);
  });
});

/**
 * Etape 6a, tache 5 bis — **la charge du boss, le deuxieme effet qui touche le
 * DEPLACEMENT**.
 *
 * ⚠️ **C'est le meme risque que le ralentissement du Givre a l'etape 5a**, et
 * ce fichier a deja tranche un cas identique : un effet qui pilote une position
 * touche le contrat de replication a 0,000 px. La parade est celle qui a deja
 * servi trois fois — le serveur annonce UNE FOIS (origine, direction, longueur,
 * largeur, ticks), et les deux cotes DERIVENT la position le long du couloir.
 *
 * Les trois memes marches que pour le Givre :
 * 1. **la charge deplace reellement** (scenario 11a) — la garde anti-fixture,
 *    sans laquelle « 0,000 px » ne distinguerait pas un rejeu exact d'un effet
 *    qui ne s'applique a personne ;
 * 2. **sans rejeu, ca derive** (scenario 11b) ;
 * 3. **avec rejeu, ca retombe a zero** (scenario 11c).
 */
describe('etape 6a : la charge du boss survit a la latence, avec et sans rejeu', () => {
  const WAVE_ID = 1;
  /**
   * L'entite qui charge : un index quelconque de la grappe, PAS le zero.
   *
   * ⚠️ **Piege de fixture evite** : l'index 0 est le premier creneau, donc
   * celui que `#applyCharge` trouverait meme si `slotOf` etait remplace par un
   * `0` constant. Un index au milieu de la grappe ne beneficie d'aucune
   * coincidence de ce genre.
   */
  const BOSS_INDEX = 431;
  /**
   * Calendrier des annonces. 151 et 137 pour la meme raison que `DEATH_START`
   * et `DEATH_INTERVAL` : ni l'un ni l'autre n'est multiple de `stepsPerField`
   * (3), donc les ticks d'annonce successifs parcourent les trois restes
   * possibles et un `primeFieldForReplay` faux ailleurs que sur les frontieres
   * ne peut pas passer inapercu.
   */
  const CHARGE_START = 151;
  const CHARGE_INTERVAL = 137;
  const CHARGES = 3;
  const CLIENT_DELAY: readonly number[] = [0, 1, 2, 3, 2];
  const END = CHARGE_START + CHARGES * CHARGE_INTERVAL + 60;

  interface ChargeParticipant {
    horde: Horde;
    fields: FlowField[];
    playerHistory: PlayerHistory;
    hordeHistory: HordeHistory;
    charge: BossCharge | null;
    lateCharges: number;
  }

  function makeChargeParticipant(mapSeed: number): ChargeParticipant {
    const horde = new Horde(4000);
    const probe = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
    const mask = generateObstacles(mapSeed, probe.cols, probe.rows);
    const fields = Array.from({ length: 4 }, () => {
      const f = new FlowField(MAP_SIZE, FLOWFIELD_CELL);
      applyObstacles(f, mask);
      return f;
    });
    return {
      horde,
      fields,
      playerHistory: new PlayerHistory(),
      hordeHistory: new HordeHistory(horde.capacity),
      charge: null,
      lateCharges: 0,
    };
  }

  function maxDriftBetween(reference: Horde, participant: Horde): number {
    let maxDrift = 0;
    for (let slot = 0; slot < reference.count; slot++) {
      const other = participant.slotOf(reference.entityIdAt(slot));
      if (other < 0) {
        continue;
      }
      const drift = Math.hypot(
        (participant.x[other] ?? 0) - (reference.x[slot] ?? 0),
        (participant.y[other] ?? 0) - (reference.y[slot] ?? 0),
      );
      if (drift > maxDrift) {
        maxDrift = drift;
      }
    }
    return maxDrift;
  }

  function primeFieldForReplay(p: ChargeParticipant, atTick: number, stepsPerField: number): void {
    const lastDue = atTick - (((atTick % stepsPerField) + stepsPerField) % stepsPerField);
    const seen = p.playerHistory.delayed(lastDue);
    if (seen) {
      for (let f = 0; f < 4; f++) {
        p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
      }
    }
  }

  function replayTick(p: ChargeParticipant, tick: number, stepsPerField: number): void {
    if (tick % stepsPerField === 0) {
      const seen = p.playerHistory.delayed(tick);
      if (seen) {
        for (let f = 0; f < 4; f++) {
          p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        p.horde.retarget(seen.x, seen.y);
      }
    }
    p.horde.step(DT, p.fields, tick, undefined, p.charge);
    p.hordeHistory.record(tick, p.horde);
  }

  /**
   * Installe une charge annoncee AVEC rejeu : restaure au `windupTick`, pose,
   * rejoue jusqu'au present. Miroir exact de `GameClient#applyBossCharge`.
   */
  function applyChargeWithReplay(
    p: ChargeParticipant,
    charge: BossCharge,
    currentTick: number,
    stepsPerField: number,
  ): void {
    p.charge = charge;
    if (charge.windupTick >= currentTick) {
      return;
    }
    if (!p.hordeHistory.restore(charge.windupTick, p.horde)) {
      p.lateCharges++;
      return;
    }
    primeFieldForReplay(p, charge.windupTick, stepsPerField);
    for (let t = charge.windupTick + 1; t <= currentTick; t++) {
      replayTick(p, t, stepsPerField);
    }
  }

  interface ChargeScenarioResult {
    reference: Horde;
    clients: ChargeParticipant[];
    maxDrift: number;
    /** Charges effectivement annoncees — le scenario ne prouve rien a zero. */
    announced: number;
    /** Distance totale parcourue par le boss le long de ses couloirs. */
    charged: number;
  }

  /**
   * Le scenario commun : cinq participants, mille entites en grappe, et un
   * serveur qui annonce une charge tous les `CHARGE_INTERVAL` ticks depuis la
   * position REELLE de son boss, vers le joueur le plus proche. Chaque client
   * l'apprend `delay` ticks plus tard.
   *
   * `withCharge = false` donne le temoin : exactement la meme run, sans jamais
   * annoncer — c'est lui qui permet de dire de combien la charge a REELLEMENT
   * deplace le boss.
   */
  function runChargeScenario(
    mapSeed: number,
    withReplay: boolean,
    withCharge = true,
    delays: readonly number[] = CLIENT_DELAY,
  ): ChargeScenarioResult {
    const parts = Array.from({ length: PARTICIPANTS }, () => makeChargeParticipant(mapSeed));
    const reference = parts[0];
    if (!reference) {
      throw new Error('aucun participant');
    }
    const clients = parts.slice(1);

    const order: WaveOrder = {
      waveId: WAVE_ID,
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

    const bossId = entityIdOf(WAVE_ID, BOSS_INDEX);
    const stepsPerField = Math.max(1, Math.round(TICK_HZ / FLOWFIELD_HZ));
    const announced: BossCharge[] = [];
    let maxDrift = 0;
    let charged = 0;
    // Meme masque que `pendingDeath`/`pendingZone` : pendant que l'annonce est
    // en vol, le client n'a pas encore de quoi corriger, et cet ecart est du au
    // transit reseau, pas a la qualite de la correction.
    const pendingCharge: boolean[] = clients.map(() => false);

    for (let tick = 0; tick < END; tick++) {
      const xs = [0, 1, 2, 3].map((pl) => 3000 + Math.cos(tick * 0.02 + pl) * 1500);
      const ys = [0, 1, 2, 3].map((pl) => 3000 + Math.sin(tick * 0.02 + pl) * 1500);

      for (const p of parts) {
        p.playerHistory.record(tick, xs, ys);
        if (tick % stepsPerField === 0) {
          const seen = p.playerHistory.delayed(tick);
          if (seen) {
            for (let f = 0; f < 4; f++) {
              p.fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
            }
            p.horde.retarget(seen.x, seen.y);
          }
        }
        p.horde.step(DT, p.fields, tick, undefined, p.charge);
      }

      // Le serveur annonce APRES avoir fait avancer sa horde — l'ordre de
      // `Room.step`, ou `#stepBossCharge` tourne apres `horde.step`.
      if (
        withCharge &&
        tick >= CHARGE_START &&
        (tick - CHARGE_START) % CHARGE_INTERVAL === 0 &&
        announced.length < CHARGES
      ) {
        const slot = reference.horde.slotOf(bossId);
        if (slot >= 0) {
          const charge = makeBossCharge(
            bossId,
            reference.horde.x[slot] ?? 0,
            reference.horde.y[slot] ?? 0,
            xs[0] ?? 0,
            ys[0] ?? 0,
            tick,
          );
          reference.charge = charge;
          announced.push(charge);
          charged += charge.length;
          pendingCharge.fill(true);
        }
      }

      clients.forEach((p, i) => {
        p.hordeHistory.record(tick, p.horde);
        const delay = delays[i + 1] ?? 0;
        for (const charge of announced) {
          if (charge.windupTick + delay !== tick) {
            continue;
          }
          if (withReplay) {
            applyChargeWithReplay(p, charge, tick, stepsPerField);
          } else {
            // Sans rejeu : la charge est installee au present, avec ses ticks
            // d'origine. C'est le defaut que le rejeu corrige.
            p.charge = charge;
          }
          pendingCharge[i] = false;
        }
      });

      clients.forEach((p, i) => {
        if (pendingCharge[i]) {
          return;
        }
        const drift = maxDriftBetween(reference.horde, p.horde);
        if (drift > maxDrift) {
          maxDrift = drift;
        }
      });
    }

    return {
      reference: reference.horde,
      clients,
      maxDrift,
      announced: announced.length,
      charged,
    };
  }

  /**
   * De combien la charge a-t-elle reellement deplace le boss ? Compare la meme
   * run avec et sans charge — meme graine, meme calendrier, meme horde.
   *
   * ⚠️ **C'est la garde anti-fixture**, celle que le scenario Z0 joue pour le
   * Givre. Sans elle, « 0,000 px » ne distinguerait pas un rejeu exact d'une
   * charge qui ne deplacerait personne.
   */
  it('scenario 11a — la charge deplace reellement le boss, et lui seul', () => {
    const seed = 0xc0de_0011;
    const avec = runChargeScenario(seed, true, true).reference;
    const sans = runChargeScenario(seed, true, false).reference;
    const bossId = entityIdOf(WAVE_ID, BOSS_INDEX);
    const a = avec.slotOf(bossId);
    const s = sans.slotOf(bossId);
    const ecart = Math.hypot(
      (avec.x[a] ?? 0) - (sans.x[s] ?? 0),
      (avec.y[a] ?? 0) - (sans.y[s] ?? 0),
    );

    process.stdout.write(
      `scenario 11a (la charge deplace) : le boss finit a ${ecart.toFixed(3)} px du temoin sans charge\n`,
    );

    // Derive de la constante, jamais recopiee : trois charges de
    // `BOSS_CHARGE_LENGTH_PX` deplacent le boss bien plus loin que sa marche.
    // Un dixieme d'UNE longueur suffit a distinguer « ca deplace » de « ca ne
    // deplace pas », et laisse toute latitude au retour du champ de flux entre
    // deux charges.
    expect(ecart).toBeGreaterThan(BOSS_CHARGE_LENGTH_PX / 10);
  });

  it('scenario 11b — sans rejeu, une charge installee au present laisse une derive mesurable', () => {
    const result = runChargeScenario(0xc0de_0012, false);

    process.stdout.write(
      `scenario 11b (sans rejeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
        `${result.announced} charges annoncees\n`,
    );

    expect(result.announced).toBe(CHARGES);
    // Le boss lui-meme reconverge des l'installation (sa position est une
    // fonction du tick) ; ce qui NE reconverge pas, ce sont ses voisins, que la
    // separation a pousses contre un boss qui n'etait pas au bon endroit
    // pendant le transit. C'est ce residu que le rejeu efface.
    expect(result.maxDrift).toBeGreaterThan(0);
  });

  /**
   * ⚠️ **LE chiffre de la tache.** Le meme que le scenario 9 pour les morts et
   * le scenario Z2 pour les zones : zero, pas « petit ».
   */
  it('scenario 11c — avec rejeu, la derive retombe a zero malgre la charge', () => {
    const result = runChargeScenario(0xc0de_0013, true);

    process.stdout.write(
      `scenario 11c (avec rejeu, charge en jeu) : derive maximale ${result.maxDrift.toFixed(3)} px, ` +
        `${result.announced} charges annoncees, boss deplace de ${result.charged} px par ses couloirs\n`,
    );

    expect(result.announced).toBe(CHARGES);
    for (const p of result.clients) {
      // 1 a 3 ticks de retard tiennent largement dans ROLLBACK_DEPTH_TICKS(8).
      expect(p.lateCharges).toBe(0);
    }
    expect(result.maxDrift).toBe(0);
  });
});
