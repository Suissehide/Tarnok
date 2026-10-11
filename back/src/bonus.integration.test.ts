import type { AddressInfo } from 'node:net';
import { PLAYER_MAX_HP } from '@shared/constants';
import { decode, encodeHello, MSG } from '@shared/protocol';
import { priceOf, SHOP_ITEMS } from '@shared/shop';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

// Import en espace de noms, pas nomme : le test de la panne de lecture
// espionne `purchasesOf` par-dessus le LIEN VIVANT que `server.ts` importe --
// un import nomme serait copie a la liaison et `spyOn` ne mordrait pas (meme
// piege que handshake.integration.test.ts sur `findAccountIdByToken`).
import * as comptes from './accounts';
import { buildServer } from './server';

/**
 * **La tache 6 de l'etape 7b : les achats d'un compte changent sa run
 * suivante.**
 *
 * ⚠️ **Ce fichier duplique son propre harnais, comme tous les fichiers
 * d'integration de ce depot** (voir `credit.integration.test.ts`) : aucun
 * fichier d'integration n'en importe un autre.
 */

const ROOM_SEED = 0x07_6b_0006;

type App = Awaited<ReturnType<typeof buildServer>>;

interface Client {
  ws: WebSocket;
  playerId: number;
}

let app: App;
let port: number;
const openSockets: WebSocket[] = [];

beforeEach(async () => {
  await comptes.prisma.account.deleteMany();
  app = await buildServer({ roomSeed: ROOM_SEED });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) {
    ws.close();
  }
  await app.close();
});

async function createRoomCode(): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/rooms' });
  return res.json<{ code: string }>().code;
}

/** Attend `probe` (sync ou async), ou leve au bout de `timeoutMs`. */
async function attendre<T>(
  probe: () => T | null | Promise<T | null>,
  quoi: string,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`${quoi} : rien en ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, 8));
  }
}

/** Frappe un compte neuf, sans aucun achat. */
async function compteNeuf(): Promise<{ token: Uint8Array; accountId: string }> {
  const { id, token } = await comptes.createAccount();
  return { token, accountId: id };
}

/** Connecte une socket de jeu avec un jeton DEJA frappe. */
async function connectAvecJeton(code: string, token: Uint8Array): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${code}`);
  ws.binaryType = 'arraybuffer';
  openSockets.push(ws);

  // ⚠️ L'ecoute de 'open' est posee ICI, avant tout `await` : sur localhost
  // la socket peut s'ouvrir avant la fin d'un aller-retour Prisma, et un
  // listener pose apres l'aurait ratee (455 s perdues a la tache 5 de
  // l'etape 7a sur ce meme piege, voir `credit.integration.test.ts`).
  const ouverte = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });

  const client: Client = { ws, playerId: 0 };

  // ⚠️ L'ecoute de 'message' est posee AVANT l'envoi du HELLO, sinon le
  // WELCOME peut arriver avant qu'on ecoute.
  ws.on('message', (data: ArrayBuffer) => {
    const msg = decode(data);
    if (msg.type === MSG.WELCOME) {
      client.playerId = msg.playerId;
    }
  });

  await ouverte;
  ws.send(encodeHello(token));

  await attendre(() => (client.playerId !== 0 ? client.playerId : null), 'WELCOME', 3000);
  return client;
}

describe('etape 7b tache 6 : les achats changent la run', () => {
  /**
   * Le coeur de l'etape : un achat se VOIT dans la partie suivante. La mutation
   * « ignorer les bonus du compte » doit rougir ici.
   */
  it('la vitalite achetee monte le maximum de vie du joueur', async () => {
    const v = SHOP_ITEMS.find((i) => i.bonusKind === 'maxHp');
    if (!v) {
      throw new Error('aucun article de vitalite');
    }
    const { token, accountId } = await compteNeuf();
    await comptes.creditAccounts([accountId], BigInt(priceOf(v, 1)));
    expect(await comptes.buyItem(accountId, v.id)).toBe('ok');

    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, token);
    await attendre(() => (room.playerCount === 1 ? true : null), 'connexion', 3000);

    const attendu = PLAYER_MAX_HP + (v.perLevel ?? 0);
    expect(room.maxHpOf(client.playerId)).toBe(attendu);
  });

  it('un compte sans achat garde exactement les valeurs de base', async () => {
    const { token } = await compteNeuf();
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }
    const client = await connectAvecJeton(code, token);
    await attendre(() => (room.playerCount === 1 ? true : null), 'connexion', 3000);
    expect(room.maxHpOf(client.playerId)).toBe(PLAYER_MAX_HP);
  });

  /**
   * Review Focus n°4 : une panne de lecture ne doit pas refuser la partie. Le
   * joueur entre SANS ses ameliorations plutot que de ne pas entrer — son or
   * est en base, la run suivante les retrouvera.
   *
   * ⚠️ **Ronde de correction de la revue finale : « entre SANS ses
   * ameliorations » veut dire des bonus NULS, jamais PARTIELS, et c'est ce que
   * l'espion sur `join` assene.** Le §6.2 de la spec promet seulement que la
   * partie n'est pas refusee ; le code tient davantage — l'assignation de
   * `grants` est atomique dans le meme `try`, donc une panne ne laisse JAMAIS
   * un demi-jeu de bonus. Cette propriete-la n'etait gardee par rien : la seule
   * assertion de bonus ci-dessous est `maxHpOf`, donc un `grants` partiel qui
   * remplirait `speed`, `fireRate` ou `regen` sans toucher `maxHp` passait au
   * vert. L'espion verifie que `join` recoit `undefined` — pas un objet
   * incomplet — ce qui ferme les six cles d'un coup sans ajouter aucune couture
   * dans le code de production.
   *
   * ⚠️ L'espion ne remplace PAS `join` : `vi.spyOn` garde l'implementation
   * reelle, donc le joueur entre pour de vrai et les assertions de bout en bout
   * ci-dessous restent exercees.
   */
  it('une base injoignable au chargement des achats laisse entrer le joueur sans AUCUN bonus', async () => {
    const { token } = await compteNeuf();
    const code = await createRoomCode();
    const room = app.rooms.get(code);
    if (!room) {
      throw new Error('salon introuvable');
    }

    const espion = vi
      .spyOn(comptes, 'purchasesOf')
      .mockRejectedValue(new Error('base injoignable'));
    const espionJoin = vi.spyOn(room, 'join');
    try {
      const client = await connectAvecJeton(code, token);
      await attendre(
        () => (room.playerCount === 1 ? true : null),
        'connexion malgre la panne',
        5000,
      );
      expect(espion).toHaveBeenCalledTimes(1);
      expect(room.maxHpOf(client.playerId)).toBe(PLAYER_MAX_HP);
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      // Aucun `AccountGrants`, pas un `AccountGrants` a moitie rempli.
      expect(espionJoin).toHaveBeenCalledTimes(1);
      expect(espionJoin).toHaveBeenCalledWith(client.playerId, undefined);
    } finally {
      espionJoin.mockRestore();
      espion.mockRestore();
    }
  });
});
