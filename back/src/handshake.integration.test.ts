import { randomBytes } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { encodeHello, MSG, TOKEN_BYTES } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Import en espace de noms, pas nomme : le test du compte resolu APRES la
// fermeture (C2) a besoin d'espionner `findAccountIdByToken` par-dessus le
// LIEN VIVANT que `server.ts` importe -- un simple `const { x } = require(...)`
// recopie la valeur et laisserait `server.ts` appeler l'originale.
import * as accounts from './accounts';
import { buildServer, CLOSE_CODES } from './server';

type App = Awaited<ReturnType<typeof buildServer>>;

let app: App;
let port: number;
const sockets: WebSocket[] = [];

beforeEach(async () => {
  await accounts.prisma.account.deleteMany();
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

/**
 * Poignee de main WS minimaliste, en TCP brut : contourne entierement le
 * client `ws`, qui ne laisse aucun moyen de produire une trame invalide
 * (RSV pose, opcode inconnu, non masquee) depuis son API publique. Ces
 * erreurs sont au niveau DU PROTOCOLE WS, sous `decode()` -- c'est le seul
 * moyen d'atteindre reellement le receiver de `ws` cote serveur (C3).
 */
function poigneeDeMainBrute(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' }, () => {
      const cle = randomBytes(16).toString('base64');
      socket.write(
        `GET ${path} HTTP/1.1\r\n` +
          `Host: 127.0.0.1:${port}\r\n` +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Key: ${cle}\r\n` +
          'Sec-WebSocket-Version: 13\r\n' +
          '\r\n',
      );
    });
    socket.once('error', reject);
    let recu = '';
    const surDonnees = (chunk: Buffer): void => {
      recu += chunk.toString('latin1');
      if (recu.includes('\r\n\r\n')) {
        socket.off('data', surDonnees);
        if (!recu.startsWith('HTTP/1.1 101')) {
          reject(new Error(`upgrade refusee : ${recu.split('\r\n')[0]}`));
          return;
        }
        resolve(socket);
      }
    };
    socket.on('data', surDonnees);
  });
}

describe('etape 7a tache 5 : HELLO avant le slot', () => {
  it('un HELLO valide obtient un WELCOME', async () => {
    const code = await salon();
    const { token } = await accounts.createAccount();
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
    ws.send(encodeHello(accounts.newToken()));
    const vu = await premiere(ws);
    expect(vu.closed).toBe(4006);
  });

  /**
   * Review Focus n1 : un premier message qui n'est pas un HELLO, ou un HELLO
   * tronque, doit fermer CETTE socket - jamais lever une exception non
   * attrapee, qui couperait la partie des autres joueurs du salon.
   */
  it('un premier message qui n est pas un HELLO valide ferme cette socket seule', async () => {
    const code = await salon();
    const { token } = await accounts.createAccount();

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
   * S2.1 de la spec : le jeton ne passe JAMAIS par une URL. Ce test le
   * prouve par la negative cote serveur - un client qui glisserait son jeton
   * dans la chaine de requete, sans envoyer de HELLO, ne doit obtenir AUCUN
   * slot. Si le serveur lisait l'URL, ce test passerait au vert et le jeton
   * se mettrait a fuir dans les journaux du reverse proxy.
   */
  it('un jeton dans l URL ne vaut RIEN : le serveur ne lit que le HELLO', async () => {
    const code = await salon();
    const { token } = await accounts.createAccount();
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/ws?room=${code}&token=${Buffer.from(token).toString('base64url')}`,
    );
    ws.binaryType = 'arraybuffer';
    sockets.push(ws);
    await attendOuvert(ws);
    // Aucun HELLO envoye, bien que l'URL porte un jeton valide.
    expect(await premiere(ws)).toEqual({});
  });

  /**
   * Review Focus n2, ronde de correction 2/5 (C1) : un second HELLO ne doit
   * JAMAIS attribuer un second slot. Sans garde, un client bavard
   * occuperait les quatre places a lui seul.
   *
   * ⚠️ **Les deux HELLO partent dans la MEME volee, sans rien attendre entre
   * eux.** Un premier jet de ce test attendait le WELCOME avant d'envoyer le
   * second -- a ce moment, `onFirstSync` avait deja ete retire et le second
   * HELLO tombait dans `#onFrame`, qui l'ignore sans jamais exercer la
   * garde. Ce test restait vert alors que le bug existait (le retrait se
   * faisait APRES l'`await` Prisma) : deux HELLO arrivant dans le meme
   * segment TCP sont livres SYNCHRONIQUEMENT par le receiver de `ws`, donc
   * le second peut entrer alors que le premier est encore en attente, et
   * c'est CE scenario que la volee simultanee ci-dessous exerce.
   */
  it('un second HELLO dans la meme volee n attribue pas un second slot', async () => {
    const code = await salon();
    const { token } = await accounts.createAccount();
    const ws = ouvre(code);
    await attendOuvert(ws);

    ws.send(encodeHello(token));
    ws.send(encodeHello(token));

    expect(await premiere(ws)).toEqual({ type: MSG.WELCOME });

    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(room.playerCount).toBe(1);
  });

  /**
   * ⚠️ **Les codes de fermeture doivent etre deux a deux DISTINCTS.**
   *
   * L'etape 7a a ajoute deux codes en reutilisant par erreur 4003 et 4004,
   * deja pris par `CLOSE_ROOM_FULL` et `CLOSE_UNKNOWN_ROOM` -- et les deux
   * paires sont atteignables sur le MEME chemin de socket. Un client ne
   * pouvait donc plus distinguer « salon inconnu » (afficher une erreur de
   * code) de « jeton inconnu » (frapper un nouveau compte).
   *
   * Cet invariant remplace la vigilance par une assertion : le prochain code
   * ajoute en doublon dans `CLOSE_CODES` fera rougir ce test au lieu d'etre
   * decouvert par un comportement client inexplicable.
   */
  it('les codes de fermeture sont deux a deux distincts', () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * C2 (ronde de correction 2/5) : une socket qui se ferme PENDANT l'attente
   * de la resolution du compte ne doit pas garder son slot pour toujours.
   *
   * Avant le correctif, `add` reprenait apres l'`await` de
   * `findAccountIdByToken` sans regarder l'etat de la socket : le slot etait
   * pris quand meme, `ws.send` restait un no-op silencieux (la socket est
   * fermee), et aucun `'close'` ne se representait pour declencher `remove`
   * -- le salon perdait une place pour toujours, et le timer de la `Session`
   * ne s'arretait jamais.
   *
   * `findAccountIdByToken` est remplace ici par une promesse que CE TEST
   * controle, pour forcer une fenetre large et deterministe entre le HELLO
   * et sa resolution -- sans ce controle, la vraie requete Prisma est trop
   * rapide pour que la fermeture du client la devance de facon fiable.
   *
   * ⚠️ **Autoportant (ronde de correction 3/5) :** sans l'assertion sur
   * `espion`, `playerCount === 0` serait aussi vrai si l'espionnage ne
   * mordait pas du tout (jeton inconnu -> `UNKNOWN_TOKEN` -> zero slot) --
   * seul `toHaveBeenCalledTimes(1)` prouve que ce test exerce bien le
   * chemin simule, pas un autre qui arrive au meme resultat par hasard.
   */
  it('une socket fermee pendant la resolution du compte ne garde pas son slot', async () => {
    const code = await salon();
    let resoudre: ((id: string | null) => void) | undefined;
    const espion = vi
      .spyOn(accounts, 'findAccountIdByToken')
      .mockImplementation(() => new Promise((resolve) => (resoudre = resolve)));

    try {
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(encodeHello(accounts.newToken()));

      // Laisse le HELLO atteindre le serveur et entrer dans l'attente
      // simulee de la resolution du compte, puis ferme le client AVANT
      // qu'elle ne se resolve.
      await new Promise((r) => setTimeout(r, 50));
      expect(espion).toHaveBeenCalledTimes(1);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));

      // Le compte se resout APRES la fermeture : c'est exactement la fenetre
      // que C2 corrige. L'identite du compte est sans importance ici, seul
      // compte l'etat de la socket a la reprise -- un accountId quelconque,
      // non nul, suffit a emprunter le chemin de succes de `add`.
      resoudre?.('un-compte-quelconque');
      await new Promise((r) => setTimeout(r, 50));

      const room = app.rooms.get(code);
      if (!room) {
        throw new Error('salon introuvable');
      }
      expect(room.playerCount).toBe(0);
    } finally {
      espion.mockRestore();
    }
  });

  /**
   * Meme classe que C2, cote `Session` plutot que cote socket (ronde de
   * correction 3/5) : la `Session` elle-meme peut se refermer PENDANT
   * l'attente de la resolution du compte -- le dernier joueur slote part,
   * `remove` declenche `onEmpty`, qui referme la `Session` (`stop()`,
   * `clearInterval`, et le salon retire de `app.rooms`). Avant le
   * correctif, la garde de `add` ne regardait que `ws.readyState`, pas la
   * vivacite du salon : un second joueur accueilli APRES cette fermeture
   * recevrait un WELCOME dans une partie gelee et dereferencee, sans
   * qu'aucune diffusion ne vienne jamais.
   */
  it('une session refermee pendant la resolution du compte n accueille personne', async () => {
    const code = await salon();

    // Premier et SEUL joueur du salon : son depart va refermer la Session,
    // puisque personne d'autre n'y est encore slote.
    const { token: tokenUn } = await accounts.createAccount();
    const premier = ouvre(code);
    await attendOuvert(premier);
    premier.send(encodeHello(tokenUn));
    expect(await premiere(premier)).toEqual({ type: MSG.WELCOME });

    let resoudre: ((id: string | null) => void) | undefined;
    const espion = vi
      .spyOn(accounts, 'findAccountIdByToken')
      .mockImplementation(() => new Promise((resolve) => (resoudre = resolve)));

    try {
      const second = ouvre(code);
      await attendOuvert(second);
      second.send(encodeHello(accounts.newToken()));

      // Laisse le HELLO du second entrer dans l'attente simulee, PUIS le
      // premier (et seul autre) joueur part : la Session se referme
      // pendant que le second est encore en l'air.
      await new Promise((r) => setTimeout(r, 50));
      expect(espion).toHaveBeenCalledTimes(1);
      premier.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(app.rooms.get(code)).toBeUndefined();

      // Le compte du second se resout APRES la fermeture de la Session.
      resoudre?.('un-autre-compte-quelconque');
      const vu = await premiere(second);
      expect(vu.closed).toBe(4008);
    } finally {
      espion.mockRestore();
    }
  });

  /**
   * C4 (ronde de correction 2/5) : un echec de `findAccountIdByToken` (base
   * indisponible, pool epuise) ne doit fermer QUE cette socket, jamais faire
   * tomber le process.
   *
   * Avant le correctif, `onFirstSync` appelait `void onFirst(data)` : un
   * rejet de la promesse devenait un `unhandledRejection` -- et Node
   * termine le process sur un rejet non gere, la meme consequence que C3.
   * `onFirst(data).catch(...)` capture desormais ce rejet et ferme cette
   * seule socket avec `CLOSE_CODES.INTERNAL_ERROR`.
   */
  it('un echec de resolution du compte ferme cette socket, pas le process', async () => {
    const code = await salon();
    const espion = vi
      .spyOn(accounts, 'findAccountIdByToken')
      .mockRejectedValue(new Error('pool Prisma epuise (simule)'));

    try {
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(encodeHello(accounts.newToken()));
      const vu = await premiere(ws);
      expect(vu.closed).toBe(4007);
    } finally {
      espion.mockRestore();
    }
  });

  /**
   * C3 (ronde de correction 2/5), la plus grave : une trame WS malformee
   * AVANT le HELLO ne doit tuer NI cette socket seule NI le process entier.
   *
   * Avant le correctif, `add` ne posait `ws.on('error', ...)` qu'APRES un
   * HELLO reussi. Le receiver de `ws` appelle `websocket.emit('error', err)`
   * sur une trame dont les bits RSV2/RSV3 sont poses (entre autres causes),
   * et un `EventEmitter` SANS listener `'error'` LEVE -- sans
   * `process.on('uncaughtException')` dans `back/src` pour l'attraper, le
   * process entier meurt, tous les salons de tous les joueurs avec lui.
   *
   * La trame est fabriquee en TCP brut (voir `poigneeDeMainBrute`) : le
   * client `ws` ne permet pas de produire une trame invalide depuis son API
   * publique, ce defaut vit SOUS `decode()`, au niveau du protocole WS
   * lui-meme.
   */
  it('une trame WS avec RSV pose avant le HELLO ne tue pas le process', async () => {
    const code = await salon();
    const brute = await poigneeDeMainBrute(`/ws?room=${code}`);

    try {
      // Octet 0 : FIN=0, RSV2+RSV3 poses (0x30), opcode=0 -- invalide des la
      // lecture des deux premiers octets, sans besoin de masque ni de
      // payload.
      brute.write(Buffer.from([0x30, 0x00]));
      await new Promise((r) => setTimeout(r, 100));

      // Preuve que le process est TOUJOURS VIVANT : un second client, sur
      // le MEME salon, obtient encore son WELCOME normalement.
      const { token } = await accounts.createAccount();
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(encodeHello(token));
      expect(await premiere(ws)).toEqual({ type: MSG.WELCOME });
    } finally {
      brute.destroy();
    }
  });
});
