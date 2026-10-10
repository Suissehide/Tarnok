import type { AddressInfo } from 'node:net';
import { encodeHello, MSG, TOKEN_BYTES } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { createAccount, newToken, prisma } from './accounts';
import { buildServer } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  await prisma.account.deleteMany();
  app = await buildServer({ roomSeed: 1 });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function salon(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return res.json<{ code: string }>().code;
}

function ouvre(code: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  sockets.push(ws);
  return ws;
}

function attendOuvert(ws: WebSocket): Promise<void> {
  return new Promise((res, rej) => {
    ws.once('open', () => res());
    ws.once('error', rej);
  });
}

/** Rend le premier message recu, ou le code de fermeture si la socket ferme. */
function premiere(ws: WebSocket): Promise<{ type?: number; closed?: number }> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({}), 3000);
    ws.once('message', (data: ArrayBuffer) => {
      clearTimeout(t);
      resolve({ type: new DataView(data).getUint8(0) });
    });
    ws.once('close', (code) => {
      clearTimeout(t);
      resolve({ closed: code });
    });
  });
}

describe('etape 7a tache 5 : HELLO avant le slot', () => {
  it('un HELLO valide obtient un WELCOME', async () => {
    const code = await salon();
    const { token } = await createAccount();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeHello(token));
    expect(await premiere(ws)).toEqual({ type: MSG.WELCOME });
  });

  /**
   * Le WELCOME ne doit PAS arriver avant le HELLO. Si le serveur
   * attribuait le slot a l'ouverture de la socket comme avant, ce test
   * passerait sans que l'authentification serve a rien - et le compte ne serait
   * jamais lie au joueur.
   */
  it('aucun WELCOME tant que le HELLO n est pas envoye', async () => {
    const code = await salon();
    const ws = ouvre(code);
    await attendOuvert(ws);
    expect(await premiere(ws)).toEqual({});
  });

  it('un jeton inconnu fait fermer la socket', async () => {
    const code = await salon();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeHello(newToken()));
    const vu = await premiere(ws);
    expect(vu.closed).toBe(4004);
  });

  /**
   * Review Focus n1 : un premier message qui n'est pas un HELLO, ou un HELLO
   * tronque, doit fermer CETTE socket - jamais lever une exception non
   * attrapee, qui couperait la partie des autres joueurs du salon.
   */
  it('un premier message qui n est pas un HELLO valide ferme cette socket seule', async () => {
    const code = await salon();
    const { token } = await createAccount();

    // Un joueur legitime, deja dans le salon.
    const bon = ouvre(code);
    await attendOuvert(bon);
    bon.send(encodeHello(token));
    expect(await premiere(bon)).toEqual({ type: MSG.WELCOME });

    for (const mauvais of [
      new ArrayBuffer(0),
      new ArrayBuffer(10),
      new ArrayBuffer(TOKEN_BYTES + 8),
    ]) {
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(mauvais);
      const vu = await premiere(ws);
      expect(vu.closed).toBeGreaterThanOrEqual(4000);
    }

    // Et le joueur legitime est toujours la : son salon n'est pas tombe.
    expect(bon.readyState).toBe(WebSocket.OPEN);
  });

  /**
   * Review Focus n2 : un second HELLO ne doit JAMAIS attribuer un second
   * slot. Sans garde, un client bavard occuperait les quatre places a lui
   * seul.
   */
  /**
   * S2.1 de la spec : le jeton ne passe JAMAIS par une URL. Ce test le
   * prouve par la negative cote serveur - un client qui glisserait son jeton
   * dans la chaine de requete, sans envoyer de HELLO, ne doit obtenir AUCUN
   * slot. Si le serveur lisait l'URL, ce test passerait au vert et le jeton
   * se mettrait a fuir dans les journaux du reverse proxy.
   */
  it('un jeton dans l URL ne vaut RIEN : le serveur ne lit que le HELLO', async () => {
    const code = await salon();
    const { token } = await createAccount();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${code}&token=${Buffer.from(token).toString('base64url')}`,
    );
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);
    await attendOuvert(ws);
    // Aucun HELLO envoye, bien que l'URL porte un jeton valide.
    expect(await premiere(ws)).toEqual({});
  });

  it('un second HELLO n attribue pas un second slot', async () => {
    const code = await salon();
    const { token } = await createAccount();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeHello(token));
    expect(await premiere(ws)).toEqual({ type: MSG.WELCOME });

    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const avant = room.playerCount;
    ws.send(encodeHello(token));
    await new Promise((r) => setTimeout(r, 200));
    expect(room.playerCount).toBe(avant);
  });
});
