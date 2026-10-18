import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { classOf, DEFAULT_CLASS_ID } from '@shared/classes';
import { MAX_PLAYERS, SNAPSHOT_HZ, TICK_HZ } from '@shared/constants';
import { clampToMap, PING_BURST, PING_INTENTS, PING_WINDOW_TICKS } from '@shared/ping';
import {
  decode,
  encodeAbilityUsed,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeLevelUp,
  encodeLobby,
  encodePickups,
  encodePingShown,
  encodePortalOpen,
  encodePortalResult,
  encodeReaction,
  encodeRunOver,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { bonusesOf } from '@shared/shop';
import { startingWeapons } from '@shared/weapons';
import Fastify, { type FastifyInstance } from 'fastify';
import { type WebSocket, WebSocketServer } from 'ws';

import {
  buyItem,
  createAccount,
  creditAccounts,
  findAccountIdByToken,
  goldOf,
  purchasesOf,
  textToToken,
  tokenToText,
} from './accounts';
import { FixedStepAccumulator } from './loop';
import type { AccountGrants, Outbox, Room } from './room';
import { RoomRegistry } from './rooms';

const STEP_MS = 1000 / TICK_HZ;
const BROADCAST_MS = 1000 / SNAPSHOT_HZ;

/**
 * Plafond de rattrapage. Voir `FixedStepAccumulator` : sans lui, une pause du
 * process rejoue des centaines de pas d'un coup.
 */
const MAX_CATCH_UP_STEPS = 5;

/** Periode du HUD de debug serveur (un HUD, pas des logs). */
const METRICS_PERIOD_MS = 5000;

/**
 * Codes de fermeture applicatifs, dans la plage privee 4000-4999.
 *
 * ⚠️ **Toutes les valeurs vivent ICI, et nulle part en dehors de cet objet** :
 * `handshake.integration.test.ts` verifie qu'elles sont deux a deux distinctes
 * via `Object.values(CLOSE_CODES)`. Un `const CLOSE_*` isole echapperait a ce
 * controle et pourrait entrer en collision sans que rien ne le voie.
 */
export const CLOSE_CODES = Object.freeze({
  /** Code de salon absent du registre. */
  UNKNOWN_ROOM: 4004,
  /** Salon a `MAX_PLAYERS` places, toutes deja occupees. */
  ROOM_FULL: 4003,
  /** Trame WS illisible ou de longueur inattendue, HELLO compris. */
  BAD_FRAME: 4002,
  /** Premier message recu, mais ce n'est pas un HELLO. */
  NO_HELLO: 4005,
  /** HELLO bien forme, jeton inconnu -- le client doit frapper un nouveau compte. */
  UNKNOWN_TOKEN: 4006,
  /**
   * Echec interne pendant la poignee de main (ex: base indisponible) : ce
   * n'est pas le client qui est en faute, il peut reessayer sans frapper un
   * nouveau compte.
   */
  INTERNAL_ERROR: 4007,
  /**
   * Compte reconnu, mais la Session s'est refermee (dernier joueur parti)
   * PENDANT l'attente -- le salon n'existe plus dans `app.rooms`, accueillir
   * ce client y serait l'accueillir dans une partie gelee et dereferencee.
   */
  ROOM_CLOSED: 4008,
});

/**
 * Un salon en cours d'execution : la simulation, ses sockets, et sa boucle.
 *
 * Toute la connaissance du reseau est ici. `room.ts` n'en sait rien et n'en
 * saura jamais rien : c'est ce qui rendra le passage a un salon par
 * `worker_threads` mecanique.
 */
class Session {
  readonly #clients = new Map<number, WebSocket>();
  readonly #accounts = new Map<number, string>();
  readonly #outbox: Outbox & { buffers: ArrayBuffer[] };
  readonly #timer: NodeJS.Timeout;
  /** Octets reellement pousses sur le fil : l'encodage est mutualise, pas l'envoi. */
  #wireBytes = 0;
  /**
   * Ticks de salon des derniers pings ACCEPTES, par joueur : l'anti-spam.
   * Ici et pas dans `Room` — un ping ne touche rien de la simulation.
   */
  readonly #pings = new Map<number, number[]>();
  /**
   * Vrai une fois `stop()` appelee. Relu par `add` apres chaque `await` : le
   * salon a pu se refermer pendant la resolution du compte.
   */
  #stopped = false;
  /**
   * Faux tant que l'hote n'a pas lance : la salle d'attente. Pendant ce temps
   * `Room` ne tourne pas (son tick reste a 0, les vagues partent donc du
   * lancement) et aucun `WELCOME` n'est envoye — les joueurs n'existent que
   * dans `#lobby`.
   */
  #started: boolean;
  readonly #lobby = new Map<
    number,
    { grants: AccountGrants | undefined; weaponId: number; classId: number }
  >();

  constructor(
    readonly code: string,
    readonly room: Room,
    private readonly onEmpty: (code: string) => void,
    waitingRoom = false,
  ) {
    this.#started = !waitingRoom;
    const buffers: ArrayBuffer[] = [];
    this.#outbox = { buffers, push: (msg) => buffers.push(msg) };

    const start = performance.now();
    const sim = new FixedStepAccumulator(STEP_MS, MAX_CATCH_UP_STEPS, start);
    // Un seul pas de rattrapage pour la diffusion : reenvoyer trois snapshots
    // d'affilee apres un a-coup n'aide personne, ils seraient tous perimes.
    const broadcast = new FixedStepAccumulator(BROADCAST_MS, 1, start);

    this.#timer = setInterval(() => {
      const now = performance.now();
      const steps = sim.advance(now);
      const diffuse = broadcast.advance(now) > 0;
      // Les accumulateurs avancent quand meme en salle d'attente : sans ca, le
      // lancement rattraperait d'un coup tout le temps passe a attendre.
      if (!this.#started) {
        return;
      }
      for (let i = 0; i < steps; i++) {
        this.room.step(STEP_MS / 1000);
      }
      if (diffuse) {
        this.#broadcast();
      }
    }, STEP_MS / 2);
  }

  get playerCount(): number {
    return this.#clients.size;
  }

  /**
   * Accepte une socket. Le slot n'existe qu'une fois le HELLO presente et le
   * compte reconnu : une socket non authentifiee n'occupe aucune place, donc
   * le salon plein se detecte apres le HELLO. Une socket qui ne presente
   * jamais de HELLO reste ouverte et sans slot -- aucune echeance de poignee
   * de main (dette connue).
   */
  add(ws: WebSocket): void {
    ws.binaryType = 'arraybuffer';

    // Le slot attribue a cette socket, une fois le HELLO reconnu -- `null`
    // tant qu'aucun compte n'est authentifie.
    let id: number | null = null;

    // ⚠️ Pose DES L'ENTREE de `add`, jamais apres le HELLO. `ws` emet `'error'`
    // sur une trame WS malformee (bit RSV, opcode inconnu, trame non
    // masquee...), et un `EventEmitter` SANS listener `'error'` leve : faute de
    // `process.on('uncaughtException')`, ca tuerait le process et tous les
    // salons avec lui.
    //
    // ⚠️ **`'error'` puis `'close'` arrivent pour le MEME evenement reseau.**
    // `libere` est donc idempotente : `id = null` est pose AVANT `remove`, sans
    // quoi le second appel pourrait evincer un slot deja repris par un autre
    // client entre les deux evenements.
    const libere = (): void => {
      if (id !== null) {
        const victime = id;
        id = null;
        this.remove(victime);
      }
    };
    ws.on('error', libere);
    ws.on('close', libere);

    const onFirst = async (data: ArrayBuffer): Promise<void> => {
      let token: Uint8Array;
      try {
        const msg = decode(data);
        if (msg.type !== MSG.HELLO) {
          ws.close(CLOSE_CODES.NO_HELLO, 'HELLO attendu');
          return;
        }
        token = msg.token;
      } catch {
        // Trame illisible ou tronquee : CETTE socket se ferme, jamais le
        // salon. Meme discipline que `#onFrame`.
        ws.close(CLOSE_CODES.BAD_FRAME, 'trame illisible');
        return;
      }

      const accountId = await findAccountIdByToken(token);
      if (accountId === null) {
        ws.close(CLOSE_CODES.UNKNOWN_TOKEN, 'jeton inconnu');
        return;
      }

      // ⚠️ La socket a pu se fermer PENDANT l'attente Prisma. Lui attribuer un
      // slot fuirait pour toujours : son `'close'` est deja parti, donc
      // `onEmpty` ne partirait jamais et le timer de la `Session` non plus.
      if (ws.readyState !== ws.OPEN) {
        return;
      }

      // ⚠️ La Session a pu se refermer PENDANT l'attente Prisma (dernier joueur
      // parti) : sans cette garde, le client serait accueilli dans un salon
      // gele et dereference de `app.rooms`.
      if (this.#stopped) {
        ws.close(CLOSE_CODES.ROOM_CLOSED, 'salon ferme');
        return;
      }

      // ⚠️ **Second `await` sur ce chemin : chaque frontiere asynchrone ici
      // exige de relire les gardes ci-dessus.** Son echec est attrape sur place :
      // une panne de lecture ne doit pas refuser la partie. Le joueur entre sans
      // ses ameliorations, son or reste en base pour la run suivante.
      let grants: AccountGrants | undefined;
      try {
        const achats = await purchasesOf(accountId);
        grants = { bonuses: bonusesOf(achats) };
      } catch (err) {
        console.error(`[achats] lecture echouee compte=${accountId}`, err);
      }

      // ⚠️ Les deux gardes sont RELUS apres ce second `await` : la socket peut
      // etre morte et la session arretee pendant la lecture.
      if (ws.readyState !== ws.OPEN) {
        return;
      }
      if (this.#stopped) {
        ws.close(CLOSE_CODES.ROOM_CLOSED, 'salon ferme');
        return;
      }

      const freeId = this.#freeId();
      if (freeId !== null && !this.#started) {
        // Salle d'attente : un slot, mais pas encore de place dans `Room`.
        id = freeId;
        this.#clients.set(freeId, ws);
        this.#accounts.set(freeId, accountId);
        this.#lobby.set(freeId, { grants, weaponId: NO_WEAPON, classId: DEFAULT_CLASS_ID });
        ws.on('message', (frame: ArrayBuffer) => {
          this.#onFrame(freeId, ws, frame);
        });
        this.#sendLobby();
        return;
      }
      if (freeId === null || !this.room.join(freeId, grants)) {
        ws.close(CLOSE_CODES.ROOM_FULL, 'salon plein');
        return;
      }
      id = freeId;

      this.#clients.set(freeId, ws);
      this.#accounts.set(freeId, accountId);
      ws.send(encodeWelcome(freeId, this.room.tick, this.room.mapSeed));
      ws.on('message', (frame: ArrayBuffer) => {
        this.#onFrame(freeId, ws, frame);
      });
    };

    const onFirstSync = (data: ArrayBuffer): void => {
      // ⚠️ Retire EN PREMIER, avant tout `await` : deux `HELLO` dans le meme
      // segment TCP sont livres SYNCHRONIQUEMENT par `ws`. Retire apres
      // l'`await` Prisma, ce listener attribuerait un second slot au meme
      // client.
      ws.off('message', onFirstSync);
      onFirst(data).catch(() => {
        // Echec serveur (ex: Prisma indisponible) : CETTE socket se ferme,
        // jamais le salon. Pas BAD_FRAME : la trame etait lisible, le client
        // peut reessayer sans frapper un nouveau compte.
        ws.close(CLOSE_CODES.INTERNAL_ERROR, 'erreur interne');
      });
    };

    ws.on('message', onFirstSync);
  }

  remove(id: number): void {
    this.#clients.delete(id);
    this.#pings.delete(id);
    this.#accounts.delete(id);
    this.room.leave(id);
    if (this.#clients.size === 0) {
      this.onEmpty(this.code);
      return;
    }
    if (this.#lobby.delete(id)) {
      this.#sendLobby();
    }
  }

  /** Chaque client recoit la liste, avec SON slot dans `you`. */
  #sendLobby(): void {
    const players = [...this.#lobby]
      .sort(([a], [b]) => a - b)
      .map(([playerId, e]) => ({ playerId, weaponId: e.weaponId, classId: e.classId }));
    for (const [id, ws] of this.#clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(encodeLobby(id, players));
      }
    }
  }

  /** L'hote (le plus petit slot) lance : chacun entre dans `Room` avec son arme et sa classe. */
  #start(): void {
    this.#started = true;
    for (const [id, e] of [...this.#lobby].sort(([a], [b]) => a - b)) {
      this.room.join(id, e.grants, e.weaponId === NO_WEAPON ? undefined : e.weaponId, e.classId);
      this.#clients.get(id)?.send(encodeWelcome(id, this.room.tick, this.room.mapSeed));
    }
    this.#lobby.clear();
  }

  stop(): void {
    this.#stopped = true;
    clearInterval(this.#timer);
    for (const ws of this.#clients.values()) {
      ws.close();
    }
    this.#clients.clear();
  }

  /** Rend les compteurs du salon et les remet a zero. */
  drainMetrics(): {
    salon: string;
    joueurs: number;
    'ko/s emis': number;
    'ko/s par joueur': number;
    'us encodage / snapshot': number;
    'vagues tronquees': number;
  } {
    const room = this.room.drainMetrics();
    const wireBytes = this.#wireBytes;
    this.#wireBytes = 0;
    const seconds = METRICS_PERIOD_MS / 1000;
    const players = Math.max(1, this.#clients.size);

    return {
      salon: this.code,
      joueurs: this.#clients.size,
      'ko/s emis': round2(wireBytes / 1024 / seconds),
      'ko/s par joueur': round2(wireBytes / players / 1024 / seconds),
      'us encodage / snapshot': round2(room.encodeMicros / Math.max(1, room.snapshots)),
      // Rend visible dans le HUD la saturation de la horde (plafond
      // d'entites), plutot que de la laisser silencieuse.
      'vagues tronquees': room.truncatedSpawns,
    };
  }

  #onFrame(id: number, ws: WebSocket, data: ArrayBuffer): void {
    let msg: ReturnType<typeof decode>;
    try {
      msg = decode(data);
    } catch {
      // Une trame illisible ferme cette socket-la, jamais le salon : un client
      // buggue ne doit pas pouvoir couper la partie des autres.
      ws.close(CLOSE_CODES.BAD_FRAME, 'trame illisible');
      return;
    }
    if (!this.#started) {
      const entry = this.#lobby.get(id);
      if (!entry) {
        return;
      }
      if (msg.type === MSG.PICK) {
        // Un choix hors liste (arme verrouillee, inconnue) n'est pas
        // enregistre, en silence. L'arme et la classe sont arbitrees
        // INDEPENDAMMENT : une arme invalide ne fait pas perdre une classe
        // valide du meme message. Une seule diffusion suit dans tous les cas.
        const libres = startingWeapons();
        if (msg.weaponId === NO_WEAPON || libres.includes(msg.weaponId)) {
          entry.weaponId = msg.weaponId;
        }
        if (classOf(msg.classId)) {
          entry.classId = msg.classId;
        }
        this.#sendLobby();
      } else if (msg.type === MSG.START && id === Math.min(...this.#lobby.keys())) {
        this.#start();
      }
      return;
    }
    if (msg.type === MSG.INPUT) {
      this.room.applyInput(id, msg.seq, msg.moveX, msg.moveY, msg.aimX, msg.aimY);
      return;
    }
    if (msg.type === MSG.ABILITY) {
      // Le client PROPOSE, le salon arbitre : un refus est silencieux, le
      // client le deduit de l'absence d'annonce.
      //
      // ⚠️ **Rien n'est envoye ICI, meme sur acceptation** : `useAbility` met
      // l'annonce en file et `#broadcast` la diffuse apres `DEATHS`. Envoyer
      // aussi d'ici la doublerait.
      this.room.useAbility(id, msg.aimX, msg.aimY);
      return;
    }
    if (msg.type === MSG.PING) {
      // Refus silencieux, mais envoi IMMEDIAT, contrairement au verbe : un ping
      // ne touche rien de la simulation, il n'a aucun ordre a tenir face a
      // `DEATHS`.
      if (msg.intent >= PING_INTENTS.length) {
        return;
      }
      const now = this.room.tick;
      const recents = (this.#pings.get(id) ?? []).filter((t) => now - t < PING_WINDOW_TICKS);
      if (recents.length >= PING_BURST) {
        this.#pings.set(id, recents);
        return;
      }
      recents.push(now);
      this.#pings.set(id, recents);
      this.#send(encodePingShown(id, msg.intent, clampToMap(msg.x), clampToMap(msg.y)));
      return;
    }
    if (msg.type === MSG.DRAFT_TOKEN) {
      // Un geste refuse n'est pas enregistre ; le client le verra a la
      // prochaine diffusion des intentions.
      this.room.setDraftToken(id, msg.cardIndex);
      return;
    }
    if (msg.type === MSG.VOTE) {
      // Idem : un vote refuse (portail ferme, choix inconnu) n'est pas
      // enregistre ; le client le verra a la prochaine diffusion des votes.
      this.room.setVote(id, msg.choice);
    }
  }

  /**
   * Verse la cagnotte sur le compte de CHAQUE joueur encore connecte -- la
   * TOTALITE a chacun, pas une part : diviser ferait toucher a chacun moins
   * qu'en solo, et le jeu ne doit pas punir le regroupement.
   *
   * ⚠️ **Trois tentatives, puis un journal : plafond assume.** La sortie
   * propre serait une table d'« outbox » ecrite dans la transaction de fin de
   * run et rejouee jusqu'a succes, si une perte reelle est constatee.
   */
  async #creditAccounts(): Promise<void> {
    const montant = BigInt(this.room.gold);
    // Cagnotte nulle (un wipe) : `creditAccounts` serait un no-op, ce retour
    // n'evite qu'un aller-retour Prisma.
    if (montant === 0n) {
      return;
    }
    // `remove` retire un slot de `#accounts` en meme temps que de `#clients` :
    // ses valeurs SONT les comptes encore connectes.
    const groupes = partsFortune(
      montant,
      [...this.#accounts].map(([id, accountId]) => [accountId, this.room.goldBonusOf(id)] as const),
    );
    // ⚠️ Les essais sont PAR GROUPE : rejouer le tout apres un echec partiel
    // crediterait deux fois les groupes deja passes.
    for (const [du, comptes] of groupes) {
      await this.#creditGroup(comptes, du);
    }
  }

  async #creditGroup(comptes: string[], montant: bigint): Promise<void> {
    for (let essai = 1; essai <= 3; essai++) {
      try {
        await creditAccounts(comptes, montant);
        return;
      } catch (err) {
        if (essai === 3) {
          console.error(
            `[credit] ECHEC definitif salon=${this.code} montant=${montant} comptes=${comptes.join(',')}`,
            err,
          );
          return;
        }
        // Sans delai, les trois tentatives tapent le MEME pool mort en moins de
        // 10 ms (ex. Postgres qui redemarre) et n'en valent qu'une.
        await new Promise((resolve) => setTimeout(resolve, 200 + Math.random() * 300));
      }
    }
  }

  /** Diffuse `buf` a chaque client ouvert ; `#wireBytes` ne compte que ce qui part vraiment. */
  #send(buf: ArrayBuffer): void {
    for (const ws of this.#clients.values()) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buf);
        this.#wireBytes += buf.byteLength;
      }
    }
  }

  #broadcast(): void {
    // Les ordres de vague, les morts, les ramassages, les montees de niveau
    // et la fin de run partent tous avant le snapshot DU MEME TICK : un
    // client doit connaitre l'evenement avant de voir l'etat qui en decoule.
    for (const order of this.room.drainWaveOrders()) {
      this.#send(encodeWaveOrder(order));
    }
    for (const batch of this.room.drainDeaths()) {
      this.#send(encodeDeaths(batch.tick, batch.ids));
    }
    // ⚠️ **APRES `DEATHS`, et dans le MEME drain.** Un Relais peut viser un
    // allie qui meurt au tick meme ou le verbe est accepte : le client doit
    // recevoir les deux messages dans un ordre FIXE pour deriver la meme
    // chose que le serveur. Un envoi immediat depuis `#onFrame` laisserait cet
    // ordre au hasard du reseau.
    for (const used of this.room.drainAbilities()) {
      this.#send(
        encodeAbilityUsed(used.tick, used.playerId, used.verb, used.x, used.y, used.targetId),
      );
    }
    for (const zone of this.room.drainZones()) {
      this.#send(encodeZone(zone.kind, zone.x, zone.y, zone.bornTick, zone.by));
    }
    // Une seule fois par charge, et rien ensuite : la progression du boss le
    // long de son couloir se DERIVE des ticks que ce message porte.
    for (const charge of this.room.drainBossCharges()) {
      this.#send(encodeBossCharge(charge));
    }
    // Apres les morts : le flash annonce ce que le lot DEATHS du meme tick a
    // deja emporte. `pair` est deja canonicalise par `packElementPair` cote
    // salon — deux clients doivent dessiner le meme flash pour Braise+Givre et
    // pour Givre+Braise.
    for (const reaction of this.room.drainReactions()) {
      this.#send(
        encodeReaction(
          reaction.pair,
          reaction.x,
          reaction.y,
          reaction.tick,
          reaction.synergyCharge,
        ),
      );
    }
    for (const batch of this.room.drainPickups()) {
      this.#send(encodePickups(batch.tick, batch.ids));
    }
    for (const levelUp of this.room.drainLevelUps()) {
      this.#send(encodeLevelUp(levelUp.tick, levelUp.level));
    }
    for (const open of this.room.drainDraftOpens()) {
      this.#send(encodeDraftOpen(open.deadlineTick, open.cards));
    }
    const intents = this.room.draftIntents();
    if (intents.size > 0) {
      this.#send(
        encodeDraftIntents([...intents].map(([playerId, cardIndex]) => ({ playerId, cardIndex }))),
      );
    }
    for (const res of this.room.drainDraftResults()) {
      this.#send(encodeDraftResult(res.deadlineTick, res.outcomes));
    }

    // Le portail, dans le meme ordre que le draft : l'ouverture, les votes en
    // continu, puis le verdict — et tout cela AVANT le snapshot du meme tick.
    //
    // ⚠️ **Rien de tout ceci n'annonce un gel**, a la difference de
    // `DRAFT_OPEN` : le monde continue de tourner pendant le vote.
    for (const open of this.room.drainPortalOpens()) {
      // ⚠️ **Le multiplicateur part ICI, avec l'ouverture, et nulle part
      // ailleurs** : il est constant sur toute la fenetre. Zero octet par tick
      // apres l'annonce.
      this.#send(encodePortalOpen(open.deadlineTick, open.multiplier));
    }
    const votes = this.room.portalVotes();
    if (votes.size > 0) {
      // ⚠️ **La visibilite EST la mecanique** : on ne negocie pas un choix
      // qu'on ne voit pas. `NO_VOTE` circule pour qu'on voie qui n'a pas
      // encore tranche.
      this.#send(encodeVotes([...votes].map(([playerId, choice]) => ({ playerId, choice }))));
    }
    for (const res of this.room.drainPortalResults()) {
      this.#send(encodePortalResult(res.effectTick, res.decision, res.gold));
    }

    // ⚠️ **`RUN_OVER` APRES le verdict du portail.** Une extraction termine la
    // run au tick meme du verdict : envoyee avant, la fin arriverait sans la
    // decision, et l'ecran de fin dirait « L'equipe est tombee » a une equipe
    // qui vient de PARTIR.
    const runOver = this.room.drainRunOver();
    if (runOver) {
      this.#send(encodeRunOver(runOver.tick, runOver.survivedTicks, runOver.level, runOver.kills));
      // ⚠️ **LE seul endroit qui verse l'or sur les comptes**, atteint
      // exactement une fois par run : le garde de tete de `Room#step` rend un
      // second `#endRun` inatteignable, et `drainRunOver` vide l'evenement en
      // le rendant. Ni journal ni cle d'idempotence.
      //
      // Pas dans `Room`, qui reste sans I/O pour rester testable sans base.
      void this.#creditAccounts();
    }

    this.#outbox.buffers.length = 0;
    this.room.snapshot(this.#outbox);
    for (const buf of this.#outbox.buffers) {
      this.#send(buf);
    }
  }

  /** Le plus petit identifiant libre : les places se reutilisent. */
  #freeId(): number | null {
    for (let id = 1; id <= MAX_PLAYERS; id++) {
      if (!this.#clients.has(id)) {
        return id;
      }
    }
    return null;
  }
}

/**
 * « Fortune » : ce que chaque compte touche de la cagnotte, majoree de SON
 * bonus, regroupe par montant pour qu'un `updateMany` serve tout un groupe.
 *
 * ⚠️ **Cle = COMPTE.** Deux onglets du meme compte (deux slots, un jeton) ne
 * sont credites qu'une fois — sinon la cagnotte doublerait.
 */
export function partsFortune(
  montant: bigint,
  joueurs: Iterable<readonly [accountId: string, goldBonus: number]>,
): Map<bigint, string[]> {
  const parCompte = new Map<string, bigint>();
  for (const [accountId, bonus] of joueurs) {
    parCompte.set(accountId, (montant * (100n + BigInt(Math.round(bonus * 100)))) / 100n);
  }
  const parMontant = new Map<bigint, string[]>();
  for (const [accountId, du] of parCompte) {
    parMontant.set(du, [...(parMontant.get(du) ?? []), accountId]);
  }
  return parMontant;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Le registre de salons est **decore sur l'instance Fastify** pour les tests :
 * un test qui n'a que des sockets doit pouvoir poser ses monstres dans le
 * `Room` plutot que d'attendre le generateur de vagues, lent et
 * intermittent. Les routes ci-dessous continuent de refermer `registry`.
 */
declare module 'fastify' {
  interface FastifyInstance {
    rooms: RoomRegistry;
  }
}

export interface ServerOptions {
  /**
   * Graine imposee a TOUS les salons crees par ce serveur. Absente en
   * production : `Room` en tire une au hasard. Voir `RoomRegistry.create`.
   */
  roomSeed?: number;
  /**
   * Vrai : chaque salon commence en salle d'attente (`LOBBY`/`PICK`/`START`).
   * `start()` l'allume ; faux par defaut pour que les tests d'integration, qui
   * attendent un `WELCOME` des le `HELLO`, restent ce qu'ils sont.
   */
  waitingRoom?: boolean;
}

/**
 * Lit le compte designe par un en-tete `Authorization: Bearer <jeton>`.
 *
 * ⚠️ **Rend `null` pour TOUTE forme d'echec**, et le fait sans distinguer
 * « en-tete absent », « en-tete mal forme » et « jeton inconnu » : les trois
 * doivent produire le meme 401. Distinguer renseignerait un attaquant sur
 * l'existence d'un compte.
 */
export async function accountIdFromHeader(header: string | undefined): Promise<string | null> {
  if (!header) {
    return null;
  }
  const texte = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : header;
  let token: Uint8Array;
  try {
    token = textToToken(texte.trim());
  } catch {
    return null;
  }
  return findAccountIdByToken(token);
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: process.env.CORS_ORIGIN ?? true });

  const registry = new RoomRegistry();
  app.decorate('rooms', registry);
  const sessions = new Map<string, Session>();

  const closeSession = (code: string): void => {
    sessions.get(code)?.stop();
    sessions.delete(code);
    registry.delete(code);
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post('/rooms', async (_req, reply) => {
    const { code, room } = registry.create(options.roomSeed);
    sessions.set(code, new Session(code, room, closeSession, options.waitingRoom));
    return reply.code(201).send({ code });
  });

  // Le compte anonyme : aucun formulaire. Le client appelle cette route au
  // premier chargement ou son localStorage ne porte pas deja un jeton.
  //
  // ⚠️ Pas de plafond par IP : la table est remplissable par une boucle.
  // Ecart assume, a traiter quand le jeu est expose.
  app.post('/accounts', async (_req, reply) => {
    const { token } = await createAccount();
    return reply.code(201).send({ token: tokenToText(token) });
  });

  app.get('/accounts/me', async (req, reply) => {
    const accountId = await accountIdFromHeader(req.headers.authorization);
    if (accountId === null) {
      return reply.code(401).send({ error: 'jeton absent ou inconnu' });
    }
    return reply.send({
      // ⚠️ **En TEXTE, pas en nombre.** `bigint` n'est pas serialisable en
      // JSON, et un nombre JSON perdrait la precision au-dela de 2^53 alors que
      // la colonne tient jusqu'a 2^63.
      gold: (await goldOf(accountId)).toString(),
      purchases: Object.fromEntries(await purchasesOf(accountId)),
    });
  });

  app.post('/accounts/me/purchases', async (req, reply) => {
    const accountId = await accountIdFromHeader(req.headers.authorization);
    if (accountId === null) {
      return reply.code(401).send({ error: 'jeton absent ou inconnu' });
    }
    const itemId = (req.body as { itemId?: unknown } | null)?.itemId;
    if (typeof itemId !== 'string') {
      return reply.code(400).send({ error: 'itemId manquant' });
    }

    const verdict = await buyItem(accountId, itemId);
    if (verdict === 'article-inconnu') {
      return reply.code(400).send({ error: 'article inconnu' });
    }
    if (verdict === 'solde-insuffisant' || verdict === 'palier-max') {
      // 402 Payment Required : le client a demande quelque chose qu'il ne peut
      // pas encore se payer. `palier-max` partage ce code parce que la cause
      // est de meme nature — la demande est refusee, rien n'a change.
      return reply.code(402).send({ error: verdict });
    }
    if (verdict === 'conflit') {
      // 409 : un achat concurrent (ou une panne de base) a annule la
      // transaction. Rien n'a ete debite. L'action correcte du client est de
      // rafraichir et de retenter, PAS de gagner plus d'or — c'est pourquoi ce
      // n'est pas un 402.
      return reply.code(409).send({ error: verdict });
    }
    if (verdict !== 'ok') {
      // Exhaustivite : un verdict ajoute a `buyItem` sans etre mappe ci-dessus
      // fait rougir le typecheck au lieu de rendre 200 sur un refus.
      const jamais: never = verdict;
      throw new Error(`verdict non traite : ${jamais}`);
    }
    return reply.send({
      gold: (await goldOf(accountId)).toString(),
      purchases: Object.fromEntries(await purchasesOf(accountId)),
    });
  });

  const wss = new WebSocketServer({ noServer: true });

  app.server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const code = (url.searchParams.get('room') ?? '').toUpperCase();

    wss.handleUpgrade(req, socket, head, (ws) => {
      const session = sessions.get(code);
      if (!session) {
        ws.close(CLOSE_CODES.UNKNOWN_ROOM, 'salon inconnu');
        return;
      }
      // Le salon plein se detecte apres le HELLO, pas ici : une socket non
      // authentifiee n'occupe aucune place.
      session.add(ws);
    });
  });

  // La metrique qui plafonne ce genre de jeu est l'overhead reseau, pas le CPU
  // ni la RAM : elle est mesuree en continu.
  //
  // Debrayable par TARNOK_METRICS=off : les bancs montent des dizaines de
  // salons, dont les tableaux noieraient le resultat.
  const metricsEnabled = process.env.TARNOK_METRICS !== 'off';
  const metricsTimer = setInterval(() => {
    if (!metricsEnabled) {
      return;
    }
    const rows = [...sessions.values()]
      .filter((s) => s.playerCount > 0)
      .map((s) => s.drainMetrics());
    if (rows.length > 0) {
      console.table(rows);
    }
  }, METRICS_PERIOD_MS);
  metricsTimer.unref();

  app.addHook('onClose', async () => {
    clearInterval(metricsTimer);
    for (const session of sessions.values()) {
      session.stop();
    }
    sessions.clear();
    wss.close();
  });

  return app;
}

async function start(): Promise<void> {
  const app = await buildServer({ waitingRoom: true });
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen({ port, host });
  console.log(`tarnok back a l'ecoute sur http://${host}:${port}`);
}

const entry = process.argv[1];
if (entry && pathToFileURL(entry).href === import.meta.url) {
  await start();
}
