/**
 * Banc reseau — combien d'octets par joueur, et combien de salons par machine ?
 *
 * Le §4.6 est explicite : la metrique qui a plafonne Riot (~200 parties par
 * machine) n'etait ni le CPU de simulation ni la RAM, mais **l'overhead des
 * threads reseau**. C'est donc le poste a instrumenter en premier, et le seul
 * du banc qui merite de vraies sockets plutot qu'une mesure d'encodage seule.
 *
 * Deux parties :
 *   1. Le cout d'encodage pur, sans reseau — le plancher.
 *   2. Des salons reels, avec de vrais clients WebSocket — le cout complet.
 *
 *   npm run bench:net -w back
 */

import type { AddressInfo } from 'node:net';
import { INPUT_HZ, ORB_PICKUP_RADIUS, PLAYER_MAX_HP, SNAPSHOT_HZ } from '@shared/constants';
import { encodeInput, encodeSnapshot, type PlayerSnapshot } from '@shared/protocol';
import { WebSocket } from 'ws';

import { buildServer } from '../src/server';
import { machineDescription, round2, stats } from './harness';

/** 4 joueurs, plus 0, 10 ou 20 elites — les seules entites vraiment repliquees (§3.3). */
const REPLICATED_COUNTS = [4, 14, 24];

const ENCODE_ITERATIONS = 20_000;
const ROOM_COUNTS = [1, 10, 50];
const ROOM_SECONDS = 5;

function fakeEntities(count: number): PlayerSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    x: 1000 + i * 37,
    y: 2000 - i * 19,
    hp: PLAYER_MAX_HP,
    aimX: 90,
    aimY: -60,
    pickupRadius: ORB_PICKUP_RADIUS,
  }));
}

function benchEncoding(): void {
  console.log("1. Cout d'encodage pur (sans reseau)\n");

  const rows = REPLICATED_COUNTS.map((count) => {
    const entities = fakeEntities(count);
    const durations: number[] = [];
    let bytes = 0;

    // Rodage : sans lui on mesure la compilation JIT.
    for (let i = 0; i < 2000; i++) {
      encodeSnapshot(i, 0, 0, entities);
    }

    for (let i = 0; i < ENCODE_ITERATIONS; i++) {
      const started = performance.now();
      const buf = encodeSnapshot(i, 0, 0, entities);
      durations.push((performance.now() - started) * 1000);
      bytes = buf.byteLength;
    }

    const s = stats(durations);
    // Un snapshot part a chaque joueur : c'est ce que compte « par joueur ».
    const perPlayerKoS = (bytes * SNAPSHOT_HZ) / 1024;

    return {
      'entites repliquees': count,
      'octets / snapshot': bytes,
      'ko/s par joueur': round2(perPlayerKoS),
      'us encodage (median)': round2(s.median),
      'us encodage (p95)': round2(s.p95),
    };
  });

  console.table(rows);
  console.log(
    `Rappel du §3.3 : l'estimation a valider etait de 5 a 15 ko/s par joueur.\n` +
      `Ces chiffres ne comptent que la charge utile — l'entete WebSocket (2 a 6\n` +
      `octets par trame) et TCP s'y ajoutent, et la partie 2 les inclut.\n`,
  );
}

interface RoomResult {
  rooms: number;
  bytesReceived: number;
  clients: number;
  cpuMs: number;
  wallMs: number;
}

async function benchRooms(rooms: number): Promise<RoomResult> {
  const app = await buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;

  const sockets: WebSocket[] = [];
  const inputTimers: ReturnType<typeof setInterval>[] = [];
  let bytesReceived = 0;

  try {
    for (let r = 0; r < rooms; r++) {
      const res = await app.inject({ method: 'POST', url: '/rooms' });
      const { code } = res.json<{ code: string }>();

      for (let p = 0; p < 4; p++) {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
        ws.binaryType = 'arraybuffer';
        sockets.push(ws);
        ws.on('message', (data: ArrayBuffer) => {
          bytesReceived += data.byteLength;
        });
        await new Promise<void>((resolve, reject) => {
          ws.once('open', resolve);
          ws.once('error', reject);
        });
      }
    }

    // Les clients envoient leurs entrees comme en jeu : la charge montante
    // compte aussi dans le budget d'un salon.
    let seq = 0;
    for (const ws of sockets) {
      inputTimers.push(
        setInterval(() => {
          if (ws.readyState === ws.OPEN) {
            seq = (seq + 1) & 0xffff;
            // Visee non nulle (tache 13) : un vrai client vise presque toujours
            // quelque chose, la charge montante doit en tenir compte.
            ws.send(encodeInput(seq, 127, 40, 90, -60));
          }
        }, 1000 / INPUT_HZ),
      );
    }

    // On ne compte qu'a partir d'ici : la connexion des sockets ne fait pas
    // partie du cout de croisiere d'un salon.
    bytesReceived = 0;
    const cpuBefore = process.cpuUsage();
    const wallBefore = performance.now();

    await new Promise((r) => setTimeout(r, ROOM_SECONDS * 1000));

    const cpu = process.cpuUsage(cpuBefore);
    const wallMs = performance.now() - wallBefore;

    return {
      rooms,
      bytesReceived,
      clients: sockets.length,
      cpuMs: (cpu.user + cpu.system) / 1000,
      wallMs,
    };
  } finally {
    for (const timer of inputTimers) {
      clearInterval(timer);
    }
    for (const ws of sockets) {
      ws.close();
    }
    await app.close();
  }
}

async function main(): Promise<void> {
  // Le HUD serveur imprimerait cinquante lignes toutes les cinq secondes et
  // noierait le tableau qu'on vient lire.
  process.env.TARNOK_METRICS = 'off';

  console.log(`Banc reseau — ${machineDescription()}`);
  console.log(`Diffusion a ${SNAPSHOT_HZ} Hz, entrees a ${INPUT_HZ} Hz.\n`);

  benchEncoding();

  console.log('2. Salons reels, vrais clients WebSocket, 4 joueurs par salon\n');
  const rows: Record<string, number | string>[] = [];
  for (const rooms of ROOM_COUNTS) {
    const r = await benchRooms(rooms);
    const seconds = r.wallMs / 1000;
    const koPerPlayer = r.bytesReceived / r.clients / 1024 / seconds;

    rows.push({
      salons: r.rooms,
      joueurs: r.clients,
      'ko/s par joueur': round2(koPerPlayer),
      'ko/s total': round2(r.bytesReceived / 1024 / seconds),
      'CPU % (1 coeur)': round2((r.cpuMs / r.wallMs) * 100),
      'CPU % par salon': round2((r.cpuMs / r.wallMs / r.rooms) * 100),
    });
  }
  console.table(rows);

  const last = rows[rows.length - 1];
  const perRoom = Number(last?.['CPU % par salon'] ?? 0);
  if (perRoom > 0) {
    console.log(
      `-> A ce cout, un coeur sature vers ${Math.floor(100 / perRoom)} salons.\n` +
        `   ⚠️ Serveur ET clients tournent dans le meme process : le chiffre inclut\n` +
        `   le cout des clients, donc il **sous-estime** le plafond reel. Il donne un\n` +
        `   ordre de grandeur et un point de comparaison entre versions, pas une\n` +
        `   capacite de production.`,
    );
  }
}

await main();
