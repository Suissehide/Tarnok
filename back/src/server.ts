import { pathToFileURL } from 'node:url';
import cors from '@fastify/cors';
import { classOf, DEFAULT_CLASS_ID } from '@shared/classes';
import {
  MAX_PLAYERS,
  RECONNECT_GRACE_MS,
  SNAPSHOT_HZ,
  START_GRACE_MS,
  TICK_HZ,
} from '@shared/constants';
import { clampToMap, PING_BURST, PING_INTENTS, PING_WINDOW_TICKS } from '@shared/ping';
import {
  CLOSE_CODES,
  decode,
  encodeAbilityUsed,
  encodeBossCharge,
  encodeDeaths,
  encodeDraftIntents,
  encodeDraftOpen,
  encodeDraftResult,
  encodeEvent,
  encodeLevelUp,
  encodeLobby,
  encodePickups,
  encodePingShown,
  encodePortalOpen,
  encodePortalResult,
  encodePresence,
  encodeReaction,
  encodeResync,
  encodeRunOver,
  encodeVotes,
  encodeWaveOrder,
  encodeWelcome,
  encodeZone,
  MSG,
  NO_WEAPON,
} from '@shared/protocol';
import { BONUS_ZERO, bonusesOf } from '@shared/shop';
import { startingWeapons } from '@shared/weapons';
import Fastify, { type FastifyInstance } from 'fastify';
import { type WebSocket, WebSocketServer } from 'ws';

// Les codes vivent dans `shared/protocol.ts` (le client les lit aussi) ; les
// tests du back les importent d'ici.
export { CLOSE_CODES };

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
  /**
   * Etape 18 : les comptes en grace, par compte. Le slot `id` reste tenu dans
   * `Room` (absent) le temps du minuteur ; le meme compte qui refait `HELLO`
   * sur ce code le reprend. `stop()` efface les minuteurs.
   */
  readonly #graces = new Map<string, { id: number; timer: NodeJS.Timeout }>();
  /**
   * Les sockets qui attendent leur `RESYNC` : tout joueur entre dans un salon
   * lance (reconnexion ou non). Servies dans `#broadcast`, APRES les drains et
   * AVANT le snapshot — jamais depuis `onFirst`, qui tombe entre deux
   * diffusions avec des files datees `<= T` non drainees.
   */
  readonly #resyncPending = new Set<WebSocket>();
  /** Le lancement differe de `startGraceMs` (un seul, le second `START` est ignore). */
  #startTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly code: string,
    readonly room: Room,
    private readonly onEmpty: (code: string) => void,
    waitingRoom = false,
    private readonly graceMs = RECONNECT_GRACE_MS,
    /** Le `START` attend ce delai, les `PICK` en vol passent encore. `0` : immediat. */
    private readonly startGraceMs = START_GRACE_MS,
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

      // Etape 18 : le compte est en grace sur CE code — il reprend son slot,
      // avec tout son `PlayerState`. Pas de `purchasesOf` : ses bonus de compte
      // y sont deja. La run finie pendant l'absence : salon ferme, son or est
      // au compte (§1.7).
      const grace = this.#graces.get(accountId);
      if (grace) {
        if (this.room.runOver) {
          this.#expire(accountId);
          ws.close(CLOSE_CODES.ROOM_CLOSED, 'salon ferme');
          return;
        }
        clearTimeout(grace.timer);
        this.#graces.delete(accountId);
        id = grace.id;
        this.#clients.set(grace.id, ws);
        this.#accounts.set(grace.id, accountId);
        this.room.setAbsent(grace.id, false);
        ws.send(encodeWelcome(grace.id, this.room.tick, this.room.mapSeed));
        this.#resyncPending.add(ws);
        this.#send(encodePresence(grace.id, true));
        ws.on('message', (frame: ArrayBuffer) => {
          this.#onFrame(grace.id, ws, frame);
        });
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
      // Etape 18 : un salon dont la run est finie n'accueille plus personne.
      if (this.room.runOver) {
        ws.close(CLOSE_CODES.ROOM_CLOSED, 'salon ferme');
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
      // Etape 18 : un salon lance a une horde, des zones, peut-etre un gel —
      // le `RESYNC` les lui donne a la prochaine diffusion.
      this.#resyncPending.add(ws);
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
    // Idempotente : `'error'` puis `'close'` arrivent pour le meme evenement,
    // et un slot deja en grace ne doit pas etre evince une seconde fois.
    if (!this.#clients.has(id)) {
      return;
    }
    const accountId = this.#accounts.get(id);
    this.#clients.delete(id);
    // La fenetre de ping n'est pas heritee, ni par un compte neuf ni par le
    // revenant (etape 9, etape 18).
    this.#pings.delete(id);
    this.#accounts.delete(id);
    // Etape 18 : en run, le slot est garde `graceMs` et le joueur passe absent.
    // Hors run (salle d'attente, apres `RUN_OVER`), rien ne change : le depart
    // est immediat. Un second onglet du meme compte deja en grace part aussi
    // tout de suite : une grace par compte.
    if (
      this.#started &&
      !this.room.runOver &&
      this.graceMs > 0 &&
      accountId !== undefined &&
      !this.#graces.has(accountId) &&
      this.room.positionOf(id) !== null
    ) {
      this.room.setAbsent(id, true);
      this.#send(encodePresence(id, false));
      this.#graces.set(accountId, {
        id,
        timer: setTimeout(() => this.#expire(accountId), this.graceMs),
      });
      return;
    }
    this.room.leave(id);
    this.#closeIfEmpty();
    if (this.#lobby.delete(id)) {
      this.#sendLobby();
    }
  }

  /** La grace echue : le depart reel, comme `remove` hors grace. */
  #expire(accountId: string): void {
    const grace = this.#graces.get(accountId);
    if (!grace) {
      return;
    }
    clearTimeout(grace.timer);
    this.#graces.delete(accountId);
    this.room.leave(grace.id);
    this.#closeIfEmpty();
  }

  /** `onEmpty` quand plus personne n'est connecte NI en grace. */
  #closeIfEmpty(): void {
    if (this.#clients.size === 0 && this.#graces.size === 0 && !this.#stopped) {
      this.onEmpty(this.code);
    }
  }

  /** Chaque client recoit la liste, avec SON slot dans `you`. */
  #sendLobby(): void {
    const players = [...this.#lobby]
      .sort(([a], [b]) => a - b)
      .map(([playerId, e]) => ({
        playerId,
        weaponId: e.weaponId,
        classId: e.classId,
        bonuses: e.grants?.bonuses ?? BONUS_ZERO,
      }));
    for (const [id, ws] of this.#clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(encodeLobby(id, players));
      }
    }
  }

  /**
   * Le `START` de l'hote : la run part apres `startGraceMs`, le temps que les
   * `PICK` deja en vol arrivent (ils restent appliques tant que `#started`
   * est faux). Un second `START` pendant l'attente ne fait rien.
   */
  #scheduleStart(): void {
    if (this.#startTimer !== null) {
      return;
    }
    if (this.startGraceMs <= 0) {
      this.#start();
      return;
    }
    this.#startTimer = setTimeout(() => {
      this.#startTimer = null;
      if (!this.#stopped && !this.#started) {
        this.#start();
      }
    }, this.startGraceMs);
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
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
    // ⚠️ Les minuteurs de grace aussi : un `setTimeout` de 60 s oublie fait
    // attendre Vitest apres `app.close()` et retient la `Room`.
    for (const grace of this.#graces.values()) {
      clearTimeout(grace.timer);
    }
    this.#graces.clear();
    this.#resyncPending.clear();
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
        this.#scheduleStart();
      }
      return;
    }
    if (msg.type === MSG.RESYNC_REQUEST) {
      // Etape 18 bis : un onglet revenu de l'arriere-plan demande l'etat
      // complet ; `#broadcast` le sert comme un rejoignant, avant le snapshot.
      this.#resyncPending.add(ws);
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
    // ses valeurs SONT les comptes encore connectes. Etape 18 : les comptes en
    // grace sont de la run aussi — une coupure n'est pas un choix, et
    // l'absent ne gagne jamais plus qu'un present. Cle = compte, dedoublonne.
    const groupes = partsFortune(montant, [
      ...[...this.#accounts].map(
        ([id, accountId]) => [accountId, this.room.goldBonusOf(id)] as const,
      ),
      ...[...this.#graces].map(
        ([accountId, grace]) => [accountId, this.room.goldBonusOf(grace.id)] as const,
      ),
    ]);
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
    // Etape 14 : les evenements, APRES les morts et les ramassages (« ce qui
    // en decoule »), et surtout AVANT `LEVEL_UP` — c'est ce qui garantit
    // qu'un client a lu l'`EVENT_END` reussi avant le `LEVEL_UP` qui ouvre
    // l'etalage, meme dans le meme envoi (§6.4).
    for (const ev of this.room.drainEvents()) {
      this.#send(encodeEvent(ev));
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
    // Etape 17 : comme `LEVEL_UP`, `PORTAL_OPEN` annonce un gel, sans un octet
    // de plus — il commence a `deadlineTick − PORTAL_WINDOW_TICKS + 1` et finit
    // a l'`effectTick` du verdict.
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

    // Etape 18 : le `RESYNC`, APRES tous les drains et AVANT le snapshot du
    // meme tick. Un tampon pour toutes les sockets en attente. Envoye depuis
    // `onFirst`, il serait pris a `T` avec les files de `T` non drainees :
    // des vagues en double et des morts fantomes chez le revenant.
    if (this.#resyncPending.size > 0) {
      const buf = encodeResync(this.room.resyncState());
      for (const ws of this.#resyncPending) {
        if (ws.readyState === ws.OPEN) {
          ws.send(buf);
          this.#wireBytes += buf.byteLength;
        }
      }
      this.#resyncPending.clear();
    }

    this.#outbox.buffers.length = 0;
    this.room.snapshot(this.#outbox);
    for (const buf of this.#outbox.buffers) {
      this.#send(buf);
    }
  }

  /**
   * Le plus petit identifiant libre : les places se reutilisent. Etape 18 : un
   * slot en grace est RESERVE, un cinquieme compte recoit `ROOM_FULL`.
   */
  #freeId(): number | null {
    const reserves = new Set([...this.#graces.values()].map((g) => g.id));
    for (let id = 1; id <= MAX_PLAYERS; id++) {
      if (!this.#clients.has(id) && !reserves.has(id)) {
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
  /**
   * Etape 18 : la fenetre de grace apres la chute d'une socket en run, en
   * millisecondes. `RECONNECT_GRACE_MS` par defaut ; `0` pour les tests qui
   * attendent un depart immediat.
   */
  graceMs?: number;
  /** Le delai du `START` (les `PICK` en vol passent encore). `START_GRACE_MS` par defaut, `0` pour un lancement immediat. */
  startGraceMs?: number;
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
    sessions.set(
      code,
      new Session(
        code,
        room,
        closeSession,
        options.waitingRoom,
        options.graceMs,
        options.startGraceMs,
      ),
    );
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
