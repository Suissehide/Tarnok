import { randomBytes } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { encodeHello, encodeInput, MSG, TOKEN_BYTES } from '@shared/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Import en espace de noms, pas nomme : les tests d'attente simulee espionnent
// `findAccountIdByToken` et `purchasesOf` par-dessus le LIEN VIVANT que
// `server.ts` importe ; une destructuration recopierait la valeur et
// laisserait `server.ts` appeler l'originale.
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
 * erreurs sont au niveau DU PROTOCOLE WS, sous `decode()` : c'est le seul
 * moyen d'atteindre le receiver de `ws` cote serveur.
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
   * Le WELCOME ne doit PAS arriver avant le HELLO : un slot attribue a
   * l'ouverture de la socket rendrait l'authentification inutile, et le
   * compte ne serait jamais lie au joueur.
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
   * Un premier message qui n'est pas un HELLO, ou un HELLO tronque, doit fermer CETTE socket - jamais lever une exception non
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

    // Chaque trame est remplie de zeros : son premier octet vaut 0, qui
    // n'est PAS un MSG valide (ils commencent a 1). `decode` leve donc a
    // chaque fois, et c'est BAD_FRAME (4002) qui ferme -- jamais NO_HELLO.
    for (const mauvais of [
      new ArrayBuffer(0),
      new ArrayBuffer(10),
      new ArrayBuffer(TOKEN_BYTES + 8),
    ]) {
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(mauvais);
      const vu = await premiere(ws);
      expect(vu.closed).toBe(CLOSE_CODES.BAD_FRAME);
    }

    // Et le joueur legitime est toujours la : son salon n'est pas tombe.
    expect(bon.readyState).toBe(WebSocket.OPEN);
  });

  /**
   * Une trame VALIDE et DECODABLE, mais qui n'est pas un HELLO (un client
   * sans authentification qui enverrait un INPUT en premier). Les trames du
   * test precedent sont illisibles (BAD_FRAME, 4002) ; seule celle-ci exerce
   * NO_HELLO (4005), qui suppose un `decode` reussi.
   */
  it('un INPUT envoye en premier, avant tout HELLO, ferme en NO_HELLO', async () => {
    const code = await salon();
    const ws = ouvre(code);
    await attendOuvert(ws);
    ws.send(encodeInput(0, 0, 0, 0, 0));
    const vu = await premiere(ws);
    // Chiffre nu, pas `CLOSE_CODES.NO_HELLO` : ce test doit rougir aussi si
    // `CLOSE_CODES` lui-meme se trompait de valeur.
    expect(vu.closed).toBe(4005);
  });

  /**
   * Le jeton ne passe JAMAIS par une URL, ou il fuirait dans les journaux du
   * reverse proxy : un client qui glisse son jeton dans la chaine de requete,
   * sans envoyer de HELLO, ne doit obtenir AUCUN slot.
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
   * Un second HELLO ne doit JAMAIS attribuer un second slot. Sans garde, un
   * client bavard occuperait les quatre places a lui seul.
   *
   * ⚠️ **Les deux HELLO partent dans la MEME volee, sans rien attendre entre
   * eux.** Attendre le WELCOME avant le second ferait tomber celui-ci dans
   * `#onFrame`, qui l'ignore sans exercer la garde. Deux HELLO du meme
   * segment TCP sont livres SYNCHRONIQUEMENT par le receiver de `ws` : le
   * second entre alors que le premier attend encore Prisma, et c'est CE
   * scenario qui doit etre garde.
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
   * ⚠️ **Les codes de fermeture doivent etre deux a deux DISTINCTS.** Ils
   * sont atteignables sur le MEME chemin de socket : un doublon empecherait
   * le client de distinguer, par exemple, « salon inconnu » (afficher une
   * erreur de code) de « jeton inconnu » (frapper un nouveau compte).
   */
  it('les codes de fermeture sont deux a deux distincts', () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  /**
   * Une socket qui se ferme PENDANT l'attente de la resolution du compte ne
   * doit pas garder son slot pour toujours. Si `add` reprenait apres l'`await`
   * sans regarder l'etat de la socket, le slot serait pris, `ws.send` serait
   * un no-op silencieux, et aucun `'close'` ne viendrait declencher `remove` :
   * le salon perdrait une place et le timer de la `Session` ne s'arreterait
   * jamais.
   *
   * `findAccountIdByToken` est remplace par une promesse que CE TEST controle,
   * pour une fenetre large et deterministe : la vraie requete Prisma est trop
   * rapide pour que la fermeture du client la devance de facon fiable.
   *
   * ⚠️ **Sans l'assertion sur `espion`, `playerCount === 0` serait aussi vrai
   * si l'espionnage ne mordait pas** (jeton inconnu -> `UNKNOWN_TOKEN` -> zero
   * slot) : seul `toHaveBeenCalledTimes(1)` prouve que le chemin simule est
   * exerce.
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

      // Le compte se resout APRES la fermeture. Un accountId quelconque, non
      // nul, suffit a emprunter le chemin de succes de `add`.
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
   * Meme classe que le test precedent, cote `Session` : elle peut se refermer
   * PENDANT l'attente de la resolution du compte (le dernier joueur slote
   * part, `remove` declenche `onEmpty`, qui arrete la `Session` et la retire
   * de `app.rooms`). Une garde qui ne regarderait que `ws.readyState`
   * accueillerait le second joueur dans une partie gelee et dereferencee,
   * sans qu'aucune diffusion ne vienne jamais.
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
   * Un echec de `findAccountIdByToken` (base indisponible, pool epuise) ne
   * doit fermer QUE cette socket (`CLOSE_CODES.INTERNAL_ERROR`), jamais
   * faire tomber le process : Node termine le process sur un rejet de
   * promesse non gere.
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
   * Une trame WS malformee AVANT le HELLO ne doit pas tuer le process entier.
   * Le receiver de `ws` emet `'error'` sur une trame dont les bits RSV2/RSV3
   * sont poses (entre autres), et un `EventEmitter` SANS listener `'error'`
   * LEVE : sans `process.on('uncaughtException')` dans `back/src`, le process
   * meurt avec tous les salons. Le listener doit donc etre pose des
   * l'ouverture, pas apres le HELLO.
   *
   * La trame est fabriquee en TCP brut (voir `poigneeDeMainBrute`).
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

/**
 * Le SECOND `await` de la poignee de main (`purchasesOf`, apres le compte
 * resolu) ouvre la meme fenetre que le premier : les gardes doivent etre
 * relues apres lui aussi. Meme forme que les tests ci-dessus, espion deplace
 * sur `purchasesOf`.
 */
describe('etape 7b tache 6, ronde 1 : le second await (achats) rejoue bien ses gardes', () => {
  /**
   * La socket peut se fermer PENDANT la lecture des achats : lui attribuer
   * un slot le ferait fuir pour toujours. Meme piege d'espion que plus haut :
   * `toHaveBeenCalledTimes(1)` prouve que le chemin simule est exerce.
   */
  it('une socket fermee pendant la lecture des achats ne garde pas son slot', async () => {
    const code = await salon();
    const { token } = await accounts.createAccount();
    let resoudre: ((achats: Map<string, number>) => void) | undefined;
    const espion = vi
      .spyOn(accounts, 'purchasesOf')
      .mockImplementation(() => new Promise((resolve) => (resoudre = resolve)));

    try {
      const ws = ouvre(code);
      await attendOuvert(ws);
      ws.send(encodeHello(token));

      // Laisse le HELLO atteindre le serveur, resoudre le compte (reel,
      // instantane), et entrer dans l'attente simulee de la lecture des
      // achats, puis ferme le client AVANT qu'elle ne se resolve.
      await new Promise((r) => setTimeout(r, 50));
      expect(espion).toHaveBeenCalledTimes(1);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));

      // Les achats se resolvent APRES la fermeture : c'est la fenetre que
      // la garde `readyState`, relue apres ce second `await`, doit refuser.
      resoudre?.(new Map());
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
   * La Session peut aussi se refermer PENDANT la lecture des achats du
   * second joueur.
   */
  it('une session refermee pendant la lecture des achats n accueille personne', async () => {
    const code = await salon();

    // Premier et SEUL joueur du salon : son depart va refermer la Session,
    // puisque personne d'autre n'y est encore slote (le second est coince
    // dans l'attente simulee, avant `freeId`/`join`).
    const { token: tokenUn } = await accounts.createAccount();
    const premier = ouvre(code);
    await attendOuvert(premier);
    premier.send(encodeHello(tokenUn));
    expect(await premiere(premier)).toEqual({ type: MSG.WELCOME });

    const { token: tokenDeux } = await accounts.createAccount();
    let resoudre: ((achats: Map<string, number>) => void) | undefined;
    const espion = vi
      .spyOn(accounts, 'purchasesOf')
      .mockImplementation(() => new Promise((resolve) => (resoudre = resolve)));

    try {
      const second = ouvre(code);
      await attendOuvert(second);
      second.send(encodeHello(tokenDeux));

      // Laisse le HELLO du second entrer dans l'attente simulee de la
      // lecture des achats, PUIS le premier (et seul autre) joueur part : la
      // Session se referme pendant que le second est encore en l'air.
      await new Promise((r) => setTimeout(r, 50));
      expect(espion).toHaveBeenCalledTimes(1);
      premier.close();
      await new Promise((r) => setTimeout(r, 50));
      expect(app.rooms.get(code)).toBeUndefined();

      // Les achats du second se resolvent APRES la fermeture de la Session :
      // c'est la fenetre que la garde `#stopped`, relue apres ce second
      // `await`, doit refuser.
      resoudre?.(new Map());
      const vu = await premiere(second);
      expect(vu.closed).toBe(CLOSE_CODES.ROOM_CLOSED);
    } finally {
      espion.mockRestore();
    }
  });
});
