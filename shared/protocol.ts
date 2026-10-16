/**
 * Protocole binaire, jamais de JSON sur la boucle de jeu : retrofitter du
 * binaire sur un protocole JSON coute toujours plus cher que de commencer
 * binaire.
 *
 * Tout est en little-endian, l'ordre natif de x86 et d'ARM.
 */

export const MSG = {
  WELCOME: 1,
  SNAPSHOT: 2,
  INPUT: 3,
  WAVE_ORDER: 4,
  DEATHS: 5,
  PICKUPS: 6,
  LEVEL_UP: 7,
  RUN_OVER: 8,
  DRAFT_OPEN: 9,
  DRAFT_TOKEN: 10,
  DRAFT_INTENTS: 11,
  DRAFT_RESULT: 12,
  ZONE: 13,
  REACTION: 14,
  BOSS_CHARGE: 15,
  PORTAL_OPEN: 16,
  VOTE: 17,
  VOTES: 18,
  PORTAL_RESULT: 19,
  HELLO: 20,
  LOBBY: 21,
  PICK: 22,
  START: 23,
  ABILITY: 24,
  ABILITY_USED: 25,
  PING: 26,
  PING_SHOWN: 27,
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/**
 * Position d'un joueur telle qu'elle passe sur le fil : quantifiee a l'entier.
 *
 * Pas de `xp` ici : l'experience est celle de l'equipe, et la porter par
 * joueur creerait deux sources de verite pour un seul nombre ; elle vit dans
 * `SnapshotMessage.xp`.
 *
 * `aimX`/`aimY` : la visee de CE joueur, quantifiee sur un octet signe comme
 * dans son `INPUT`. Le `SNAPSHOT` la redistribue a tous parce que chaque
 * client derive aussi les salves de ses allies pour les dessiner. `(0, 0)`
 * signifie « ce joueur ne tire pas », jamais une direction par defaut.
 */
export interface PlayerSnapshot {
  id: number;
  x: number;
  y: number;
  /** Points de vie, personnels, sur un octet. */
  hp: number;
  /** Composante X de la visee, quantifiee (-127..127). Voir la doc de l'interface. */
  aimX: number;
  /** Composante Y de la visee, quantifiee (-127..127). Voir la doc de l'interface. */
  aimY: number;
  /**
   * Rayon de ramassage de CE joueur : `ORB_PICKUP_RADIUS` plus ses achats
   * d'aimant. Voir `SNAPSHOT_PLAYER_BYTES`.
   */
  pickupRadius: number;
  /**
   * Reserve de bouclier de CE joueur, `0` chez qui ne porte pas Transcendance.
   * Voir `SNAPSHOT_PLAYER_BYTES`.
   */
  shield: number;
}

export interface WelcomeMessage {
  type: typeof MSG.WELCOME;
  playerId: number;
  tick: number;
  /** Graine de la carte d'obstacles : le client la **regenere**, il ne la recoit pas. */
  mapSeed: number;
}

export interface SnapshotMessage {
  type: typeof MSG.SNAPSHOT;
  tick: number;
  /** Experience de l'equipe, commune a tous les joueurs. Sur deux octets. */
  xp: number;
  /**
   * Charge du compteur de Synergie de l'EQUIPE, sur deux octets comme `xp`.
   * ⚠️ Un seul nombre pour l'equipe, jamais un par joueur : voir
   * `SNAPSHOT_HEADER_BYTES`.
   */
  synergy: number;
  players: PlayerSnapshot[];
  /**
   * Le boss du palier en cours, `null` quand aucun n'est en jeu.
   *
   * ⚠️ **La seule donnee PAR ENTITE que ce fil transporte, et c'est le NOMBRE
   * qui l'autorise** : un boss par palier, jamais plus d'un vivant. Ce champ
   * n'est pas un tableau et ne doit pas le devenir : le jour ou un palier fera
   * apparaitre dix boss, ce sera de la pietaille d'elite, dont la vie
   * redeviendra SERVEUR SEUL — le client apprend les morts par `DEATHS` et n'a
   * jamais eu besoin des PV de la horde.
   */
  boss: BossSnapshot | null;
  /**
   * L'or NON SECURISE de l'equipe, sur quatre octets, dans l'en-tete comme
   * `xp` et `synergy`.
   *
   * ⚠️ **C'est un TOTAL, pas un evenement.** Il est repete a chaque tick parce
   * que c'est l'enjeu du vote : un client qui aurait manque le `PORTAL_RESULT`
   * d'un palier precedent se recale au snapshot suivant sans rien rejouer. Le
   * porter par evenement demanderait un accuse de reception.
   */
  gold: number;
}

/**
 * Le boss vivant, tel que le `SNAPSHOT` le transporte, une fois par tick.
 *
 * Son identite est une identite d'entite ordinaire (`waveId * MAX_PER_WAVE +
 * index`, celle que `DEATHS` transporte) : le client la compare a ce qu'il
 * fait naitre.
 */
export interface BossSnapshot {
  id: number;
  /** Points de vie courants, arrondis a l'entier. Voir `SNAPSHOT_HEADER_BYTES`. */
  hp: number;
}

export interface InputMessage {
  type: typeof MSG.INPUT;
  seq: number;
  moveX: number;
  moveY: number;
  /**
   * Direction de visee en coordonnees MONDE, normalisee cote client puis
   * quantifiee sur un octet signe. Elle vient de la souris, donc doit
   * transiter. `(0, 0)` : le joueur ne tire pas ce tick (curseur pile sur lui,
   * ou souris jamais bougee).
   */
  aimX: number;
  aimY: number;
}

export interface WaveOrderMessage {
  type: typeof MSG.WAVE_ORDER;
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}

/**
 * S -> C : identites mortes ou ramassees pendant ce tick, batchees.
 *
 * `DEATHS` et `PICKUPS` partagent cette forme et ne different que par leur
 * octet de type. Les identites sont **triees en ordre croissant** : c'est
 * l'ordre canonique d'application, qui garantit que deux clients recevant le
 * meme lot en tirent des tableaux identiques.
 */
export interface DeathsMessage {
  type: typeof MSG.DEATHS;
  tick: number;
  ids: number[];
}

export interface PickupsMessage {
  type: typeof MSG.PICKUPS;
  tick: number;
  ids: number[];
}

/**
 * S -> C : l'equipe atteint un nouveau niveau. Pas de `playerId` :
 * l'experience est celle de l'equipe.
 *
 * ⚠️ `tick` est celui auquel le **gel** prend effet, pas celui de l'emission :
 * sans ce tick partage, chaque client figerait a la reception, donc a un tick
 * different selon sa latence, et le gel deviendrait une source de divergence.
 */
export interface LevelUpMessage {
  type: typeof MSG.LEVEL_UP;
  tick: number;
  level: number;
}

/**
 * S -> C : fin de run, une seule fois. `kills` tient sur 32 bits : une run
 * longue depasse 65 535 ennemis tues, et un message unique n'a pas a etre
 * economise.
 */
export interface RunOverMessage {
  type: typeof MSG.RUN_OVER;
  tick: number;
  survivedTicks: number;
  level: number;
  kills: number;
}

/**
 * S -> C : une zone au sol vient d'etre posee.
 *
 * Annoncee A LA CREATION parce que le client ne peut pas savoir ou finit un
 * projectile serveur : les siens sont cosmetiques, tires depuis une position
 * predite puis reconciliee. Une zone derivee localement deriverait de quelques
 * pixels, et deux zones qui se recouvrent d'un pixel decident d'une reaction.
 *
 * ⚠️ **La MORT d'une zone n'est JAMAIS annoncee.** Elle se derive de
 * `bornTick` et de `ZONE_LIFETIME_TICKS`, des deux cotes (voir
 * `ZoneField.expire`). Un `ZONE_GONE` doublerait le trafic des zones pour rien.
 *
 * ⚠️ **Pas de rayon sur le fil.** Toutes les zones portent `ZONE_RADIUS`, une
 * constante partagee : l'annoncer en ferait une seconde source de verite. Le
 * jour ou une zone portera un rayon propre, c'est un octet de plus, pas un
 * changement de modele.
 *
 * `by` est le joueur qui l'a posee : la Synergie le compare a celui de la
 * marque.
 *
 * ⚠️ **`kind` n'est pas un simple index d'element** : c'est l'octet empaquete
 * par `packZoneKind`. Le decoder avec `zoneElement` / `zoneReaction`, jamais
 * le lire brut.
 */
export interface ZoneMessage {
  type: typeof MSG.ZONE;
  /** Empaquete par `packZoneKind`. Voir `zoneElement` / `zoneReaction`. */
  kind: number;
  x: number;
  y: number;
  /** Tick de la pose. La peremption s'en derive, elle n'est pas annoncee. */
  bornTick: number;
  /** Identifiant du joueur a l'origine de la zone. */
  by: number;
}

/**
 * S -> C : une reaction a eu lieu.
 *
 * Arbitree par le serveur et annoncee parce qu'elle **tue**, a la difference
 * de la teinte elementaire, cosmetique, que le client approxime. La charge de
 * Synergie voyage ICI : les deux arrivent toujours ensemble.
 *
 * ⚠️ **Le message ne porte PAS les deux identifiants de joueurs.** C'est le
 * SERVEUR qui compare le joueur de la marque et celui du declencheur, et la
 * comparaison ne rend qu'un booleen. Envoyer les identites inviterait a
 * refaire l'arbitrage cote client, donc a le faire diverger.
 */
export interface ReactionMessage {
  type: typeof MSG.REACTION;
  /** Le couple d'elements, empaquete par `packElementPair`. */
  pair: number;
  x: number;
  y: number;
  tick: number;
  /** Cette reaction a-t-elle charge la barre d'equipe ? Voir `packElementPair`. */
  synergyCharge: boolean;
}

/**
 * S -> C : le boss charge.
 *
 * ⚠️ **UN SEUL MESSAGE, A L'ANNONCE, ET PLUS RIEN ENSUITE.** Pendant la
 * charge, la position du boss est pilotee par cette attaque et non par le
 * champ de flux. Les TICKS voyagent, la progression se DERIVE : les deux
 * cotes calculent la meme fraction sur les memes ticks, donc la meme
 * position, pour zero octet apres l'annonce.
 *
 * ⚠️ **La direction est figee au chargement et n'est jamais corrigee.** Un
 * message de suivi ferait suivre le couloir a sa cible : ce serait une taxe,
 * pas une attaque.
 *
 * ⚠️ **La longueur et la largeur SONT sur le fil, contrairement au rayon d'une
 * zone** : les zones partent par dizaines, une charge une fois toutes les
 * ~3,6 s et par boss. Quatre octets y achetent un couloir qui peut differer
 * d'un boss a l'autre sans changer le protocole.
 */
export interface BossChargeMessage {
  type: typeof MSG.BOSS_CHARGE;
  /** Identite de l'entite qui charge — la meme que celle du boss dans le `SNAPSHOT`. */
  entityId: number;
  /** Origine du couloir, quantifiee a l'entier comme toute position sur le fil. */
  x: number;
  y: number;
  /** Direction du couloir, quantifiee par `CHARGE_DIR_SCALE` (voir `shared/boss.ts`). */
  dirX: number;
  dirY: number;
  length: number;
  width: number;
  /** Tick de l'annonce : le chargement commence. */
  windupTick: number;
  /** Tick du depart. Rien ne fait mal avant lui. */
  startTick: number;
  /** Tick d'arrivee au bout du couloir. */
  endTick: number;
}

export type Message =
  | WelcomeMessage
  | SnapshotMessage
  | InputMessage
  | WaveOrderMessage
  | DeathsMessage
  | PickupsMessage
  | LevelUpMessage
  | RunOverMessage
  | DraftOpenMessage
  | DraftTokenMessage
  | DraftIntentsMessage
  | DraftResultMessage
  | ZoneMessage
  | ReactionMessage
  | BossChargeMessage
  | PortalOpenMessage
  | HelloMessage
  | VoteMessage
  | VotesMessage
  | PortalResultMessage
  | LobbyMessage
  | PickMessage
  | StartMessage
  | AbilityMessage
  | AbilityUsedMessage
  | PingMessage
  | PingShownMessage;

export interface DraftOpenMessage {
  type: typeof MSG.DRAFT_OPEN;
  deadlineTick: number;
  cards: WireCard[];
}

export interface DraftTokenMessage {
  type: typeof MSG.DRAFT_TOKEN;
  cardIndex: number;
}

export interface DraftIntentsMessage {
  type: typeof MSG.DRAFT_INTENTS;
  intents: WireIntent[];
}

export interface DraftResultMessage {
  type: typeof MSG.DRAFT_RESULT;
  /** Le tick ou le gel prend fin — le client ne peut pas le deduire. */
  deadlineTick: number;
  outcomes: WireOutcome[];
}

/**
 * S -> C : le portail s'ouvre, et il se refermera a `deadlineTick`.
 *
 * ⚠️ **Calque sur `DRAFT_OPEN`, sauf que LE MONDE NE S'ARRETE PAS** : le draft
 * gele parce qu'un choix de carte n'a pas d'enjeu temporel ; le vote ne gele
 * pas parce que le temps EST son enjeu. Ce message annonce une echeance, pas
 * un gel.
 *
 * ⚠️ **Il ne porte PAS l'or en jeu** : l'or BOUGE pendant la fenetre (les
 * monstres continuent de laisser des pieces), il vit donc dans le `SNAPSHOT`.
 *
 * ⚠️ **Il porte le MULTIPLICATEUR**, qui n'est pas dans le `SNAPSHOT` et ne
 * bouge pas pendant la fenetre : la seule ligne qui le change, dans
 * `Room#stepPortal`, s'execute APRES le verdict. Valeur constante sur la
 * fenetre, donc annoncee une fois. Le client ne peut pas le deviner : c'est un
 * reglage (`EXTRACT_MULTIPLIER_STEP`), et un client qui se connecte au palier
 * 7 n'a vu s'ouvrir aucun portail.
 */
export interface PortalOpenMessage {
  type: typeof MSG.PORTAL_OPEN;
  deadlineTick: number;
  /**
   * Le multiplicateur qui s'applique si l'equipe part MAINTENANT (1 au premier
   * portail). Celui du portail suivant s'en derive par
   * `+ EXTRACT_MULTIPLIER_STEP`. A 0,01 pres : voir `EXTRACT_MULTIPLIER_SCALE`.
   */
  multiplier: number;
}

/**
 * C -> S : le PREMIER message de toute socket de jeu, avant l'attribution du
 * slot.
 *
 * ⚠️ **Le jeton ne passe JAMAIS par une URL** : une URL atterrit dans les
 * journaux du reverse proxy, dans `Referer` et dans l'historique, et ce jeton
 * EST le compte. Le navigateur interdisant les en-tetes personnalises sur un
 * WebSocket, un premier message est la seule voie qui n'expose rien.
 */
export interface HelloMessage {
  type: typeof MSG.HELLO;
  token: Uint8Array;
}

/**
 * C -> S : je vote, ou je retire mon vote (`NO_VOTE`).
 *
 * Miroir exact de `DRAFT_TOKEN` : deux octets, un choix revocable.
 */
export interface VoteMessage {
  type: typeof MSG.VOTE;
  /** `VOTE_CHOICE.STAY`, `VOTE_CHOICE.LEAVE`, ou `NO_VOTE`. */
  choice: number;
}

/** Un vote diffuse : qui a vote quoi. Miroir de `WireIntent`. */
export interface WireVote {
  playerId: number;
  /** `VOTE_CHOICE.STAY`, `VOTE_CHOICE.LEAVE`, ou `NO_VOTE`. */
  choice: number;
}

/**
 * S -> C : qui a vote quoi, en continu.
 *
 * ⚠️ **La visibilite EST la mecanique** : on ne negocie pas un choix qu'on ne
 * voit pas.
 */
export interface VotesMessage {
  type: typeof MSG.VOTES;
  votes: WireVote[];
}

/**
 * S -> C : le portail a tranche.
 *
 * ⚠️ **`effectTick` est indispensable** : le vote se resout a la MAJORITE des
 * qu'elle est acquise, donc n'importe quand entre l'ouverture et l'echeance ;
 * le client ne peut pas recalculer ce tick.
 *
 * ⚠️ **`decision` est un VERDICT, pas un decompte.** Ce que le serveur compare
 * n'a pas a voyager (`REACTION` porte un bit, pas deux joueurs) ; le detail
 * des voix est deja passe par `VOTES`, pendant la negociation.
 *
 * ⚠️ **`decision` ne vaut JAMAIS `NO_VOTE`** : a l'echeance on tranche avec ce
 * qu'on a, et l'egalite continue.
 */
export interface PortalResultMessage {
  type: typeof MSG.PORTAL_RESULT;
  /** Le tick ou la decision prend effet — le client ne peut pas le deduire. */
  effectTick: number;
  /** `VOTE_CHOICE.STAY` ou `VOTE_CHOICE.LEAVE`. Jamais `NO_VOTE`. */
  decision: number;
  /**
   * L'or, **acquis** si l'equipe part, **reporte** si elle reste : un seul
   * champ, dont le sens se lit dans `decision`.
   */
  gold: number;
}

export const WELCOME_BYTES = 10;
/** `type u8 · seq u16 · moveX i8 · moveY i8 · aimX i8 · aimY i8`. */
export const INPUT_BYTES = 7;
/**
 * `type u8 · tick u32 · playerCount u8 · xp u16 · synergy u16 · bossId u32 ·
 * bossHp u32 · gold u32`.
 *
 * ⚠️ Les nombres d'equipe (`xp`, `synergy`, `gold`) et le boss, qui est UN,
 * vivent dans l'en-tete : repetes dans chaque bloc joueur, ils couteraient
 * plus et deviendraient plusieurs sources de verite pour un seul nombre.
 *
 * ⚠️ **`bossHp` est un u32, et la largeur est calculee.** Le boss vaut
 * `BOSS_HP_PER_PLAYER x 1,12^k x joueurs`, sans plafond sur le palier `k` : un
 * `u16` deborderait au palier 22 (~1,8 h de jeu, atteignable) et replierait le
 * boss EN SILENCE ; un `u32` tient jusqu'au palier 119. `encodeSnapshot` borne
 * explicitement plutot que de laisser `setUint32` replier, et un test le dit.
 */
export const SNAPSHOT_HEADER_BYTES = 22;

/**
 * Plus grande valeur que `gold` peut porter : un u32, largeur calculee comme
 * pour `bossHp`. L'or cumule croit en `100 x 1,12^i` par palier
 * (`shared/paliers.ts`), majore du multiplicateur d'extraction a la sortie : un
 * `u16` deborderait vers le palier 22, atteignable, et replierait la cagnotte
 * en silence au moment ou elle vaut le plus cher ; un `u32` tient au-dela du
 * palier 100.
 */
export const GOLD_MAX = 0xffff_ffff;

/**
 * Octets qu'il faut avoir recus pour connaitre le nombre de joueurs annonce :
 * `type u8 · tick u32 · playerCount u8`. Ce n'est pas une copie de
 * `SNAPSHOT_HEADER_BYTES` : voir `decodeSnapshot`.
 */
const SNAPSHOT_COUNT_BYTES = 6;

/**
 * « Aucun boss en jeu. »
 *
 * ⚠️ **Zero ne peut PAS etre une identite d'entite** : les identites valent
 * `waveId * MAX_PER_WAVE + index` (`shared/horde.ts`) avec un `waveId` qui
 * commence a 1, donc `0..MAX_PER_WAVE - 1` est inhabitable. Un test le derive
 * de `entityIdOf`.
 *
 * ⚠️ **La sentinelle est sur l'IDENTITE, jamais sur les PV.** Un boss a 0 PV
 * est un boss (il meurt au tick suivant, par `DEATHS`) : lire « pas de boss »
 * dans un `hp` nul ferait disparaitre sa barre juste avant sa mort.
 */
export const NO_BOSS_ID = 0;

/** Plus grande valeur que `bossHp` peut porter : voir `SNAPSHOT_HEADER_BYTES`. */
export const BOSS_HP_MAX = 0xffff_ffff;
/**
 * `id u8 · x i16 · y i16 · hp u16 · aimX i8 · aimY i8 · pickupRadius u8 ·
 * shield u8`.
 *
 * ⚠️ **`hp` est un `u16`** : chaque carte « vitalite » ajoute 20 PV maximum, et
 * des la huitieme (260) un `u8` replierait le joueur a 4 PV en silence. Un
 * plafond a 255 rendrait la carte inerte sans le dire.
 *
 * `pickupRadius` est personnel parce qu'achetable : `DerivedOrbs#capture`
 * (`front/src/net/client.ts`) ne peut pas predire le ramassage d'un coequipier
 * sans connaitre SON rayon. Un `u8` suffit : base 90 + bonus achetable 80 =
 * 170. `shared/shop.test.ts` garde `ORB_PICKUP_RADIUS +
 * maxBonus('pickupRadius') <= 255` en derivant le maximum du catalogue : c'est
 * lui qui rougira si l'on ajoute un palier d'aimant, pas la borne de
 * l'encodeur.
 *
 * `shield` : un `u8` suffit pour une reserve plafonnee. Reutiliser `hp` (chez
 * un porteur, `maxHp` vaut 1, donc `hp + bouclier` est decodable) marcherait,
 * mais serait une astuce illisible. Le champ est envoye pour tous, pas
 * seulement le porteur : `encodeSnapshot` construit UN tampon pour tout le
 * salon, un champ local demanderait un encodage par client.
 */
export const SNAPSHOT_PLAYER_BYTES = 11;
export const WAVE_ORDER_BYTES = 19;

/** En-tete commun a `DEATHS` et `PICKUPS` : type u8, tick u32, count u16. */
export const DEATHS_HEADER_BYTES = 7;
/** `type u8 · deadlineTick u32 · count u8`. */
export const DRAFT_OPEN_HEADER_BYTES = 6;
/** Une carte : `nature u8 · refId u8 · upgrade u8 · rarity u8`. */
export const DRAFT_CARD_BYTES = 4;
/** `type u8 · cardIndex u8`. */
export const DRAFT_TOKEN_BYTES = 2;
/** `type u8 · count u8`. */
export const DRAFT_INTENTS_HEADER_BYTES = 2;
/** Une intention : `playerId u8 · cardIndex u8`. */
export const DRAFT_INTENT_BYTES = 2;
/** `type u8 · deadlineTick u32 · count u8`. */
export const DRAFT_RESULT_HEADER_BYTES = 6;
/** Une issue : `playerId u8 · cardIndex u8 · outcome u8`. */
export const DRAFT_OUTCOME_BYTES = 3;

/**
 * Ce qui est arrive a un joueur, tel que l'octet `outcome` de `DRAFT_RESULT`
 * le transporte.
 *
 * Vit dans `shared/` parce que c'est une valeur de fil : `Draft` la produit,
 * `Room` la diffuse, le client la relit — et le client ne peut pas importer
 * `back/`.
 */
export const OUTCOME = {
  /** La carte lui revient — elle s'illumine chez lui. */
  WON: 0,
  /** Il visait une carte qu'un autre a eue — elle se consume chez lui. */
  LOST: 1,
  /** Il n'avait pose aucun jeton : le serveur a tranche pour lui. */
  AUTO: 2,
} as const;

/**
 * « Ce joueur n'a pose aucun jeton. »
 *
 * ⚠️ Ne peut pas valoir `0` : la carte d'indice 0 est une carte comme une
 * autre.
 */
export const NO_TOKEN = 255;

/** `type u8 · deadlineTick u32 · multiplicateur u16`, une fois par palier. */
export const PORTAL_OPEN_BYTES = 7;

/**
 * Facteur de quantification du multiplicateur d'extraction : il voyage en
 * CENTIEMES, dans un `u16`. Vit ici parce que c'est une propriete du fil ;
 * `EXTRACT_MULTIPLIER_STEP`, reglage de jeu, reste dans `shared/constants.ts`.
 *
 * ⚠️ **Des centiemes, pas un nombre de paliers restes** : le serveur dit la
 * VALEUR qu'il applique et le client ne recalcule rien. Sinon les deux cotes
 * referaient le meme calcul et divergeraient le jour ou la pente cesserait
 * d'etre lineaire.
 *
 * ⚠️ **Largeur calculee** : le multiplicateur vaut `1 + 0,25 k` apres `k`
 * « rester ». Un `u8` (2,55) deborderait au palier 7, atteignable en une
 * demi-heure ; un `u16` (655,35) au palier 2 618. `encodePortalOpen` borne
 * quand meme explicitement : un multiplicateur replie a 0,00 ferait dire au
 * client que partir ne rapporte rien. Un test le dit.
 */
export const EXTRACT_MULTIPLIER_SCALE = 100;

/** Plus grande valeur que le multiplicateur peut porter. Voir `EXTRACT_MULTIPLIER_SCALE`. */
export const EXTRACT_MULTIPLIER_MAX = 0xffff / EXTRACT_MULTIPLIER_SCALE;

/**
 * Longueur du jeton de compte, en octets : 32 octets de hasard
 * cryptographique, soit 43 caracteres en base64url. Largeur fixe, comme tout
 * le protocole : un jeton n'a aucune raison de varier.
 */
export const TOKEN_BYTES = 32;

/** `type u8 · token[32]`. */
export const HELLO_BYTES = 1 + TOKEN_BYTES;
/** `type u8 · choice u8`. */
export const VOTE_BYTES = 2;
/** `type u8 · count u8`. */
export const VOTES_HEADER_BYTES = 2;
/** Un vote : `playerId u8 · choice u8`. */
export const VOTE_ENTRY_BYTES = 2;
/**
 * `type u8 · effectTick u32 · decision u8 · gold u32`. Pas de decompte des
 * voix : voir `PortalResultMessage`.
 */
export const PORTAL_RESULT_BYTES = 10;

/**
 * Les deux faces du vote d'extraction. Valeur de fil, donc dans `shared/`,
 * comme `OUTCOME`.
 *
 * ⚠️ **`STAY` vaut ZERO, et ce n'est pas neutre** : majorite, et egalite = on
 * continue. Rester est ce qui arrive quand rien ne se decide.
 */
export const VOTE_CHOICE = {
  /** Rester : le multiplicateur monte, l'or reste non securise. */
  STAY: 0,
  /** Partir : tout est acquis, majore du multiplicateur, et la run se termine. */
  LEAVE: 1,
} as const;

/**
 * « Ce joueur n'a pas vote. »
 *
 * ⚠️ **Ne peut valoir NI 0 NI 1 : les deux sont des votes REELS.** A 0, tous
 * les silencieux voteraient « rester » : deux abstentions et un depart
 * donneraient une majorite pour rester au lieu d'une majorite pour partir.
 *
 * Une abstention circule dans `VOTES` (les autres doivent voir qui n'a pas
 * tranche) mais ne se compte pas : `PORTAL_RESULT.decision` ne la porte
 * jamais.
 */
export const NO_VOTE = 255;

/** Une identite d'entite, sur le fil : u32. */
export const DEATH_ID_BYTES = 4;

/**
 * `type u8 · kind u8 · x i16 · y i16 · bornTick u32 · by u8` = **11 octets**.
 * `kind` est l'octet empaquete par `packZoneKind`, voir `ZoneMessage`. Aucun
 * message de disparition : la mort d'une zone se derive de `bornTick`.
 */
export const ZONE_BYTES = 11;

/** `type u8 · pair u8 · x i16 · y i16 · tick u32 · synergie u8` = 11 octets. */
export const REACTION_BYTES = 11;

/**
 * `type u8 · entityId u32 · x i16 · y i16 · dirX i16 · dirY i16 · longueur u16
 * · largeur u16 · windupTick u32 · startTick u32 · endTick u32` = **29
 * octets**.
 *
 * ⚠️ **Trois ticks, bien que derivables de `BOSS_CHARGE_WINDUP_TICKS` et
 * `BOSS_CHARGE_TICKS`** : ce sont des reglages, et les envoyer rend une charge
 * en vol insensible a leur retouche comme a un client d'une autre version.
 */
export const BOSS_CHARGE_BYTES = 29;

/**
 * Facteur de quantification des composantes de direction d'une charge.
 *
 * ⚠️ **Vit ici, pas dans `shared/boss.ts`** : c'est une propriete du fil. La
 * charge l'importe pour se quantifier AVANT de partir, afin que le serveur
 * derive sa position depuis exactement les nombres que le client decodera
 * (voir `makeBossCharge`).
 *
 * 10 000 tient dans un `int16` (max 32 767) et laisse 1e-4 de resolution, soit
 * moins de 0,1 px d'ecart sur un couloir de 900 px.
 */
export const CHARGE_DIR_SCALE = 10000;

/** `type u8 · tick u32 · level u8`. */
export const LEVEL_UP_BYTES = 6;
/** `type u8 · tick u32 · survivedTicks u32 · level u8 · kills u32`. */
export const RUN_OVER_BYTES = 14;

/**
 * Ouvre une vue sur le buffer en exigeant une taille minimale : un decodeur
 * qui lit au-dela de la fin rend des valeurs fantaisistes au lieu de lever, et
 * une bogue de cadrage reseau se deguise en bogue de gameplay.
 */
function viewOf(buf: ArrayBuffer, minBytes: number): DataView {
  if (buf.byteLength < minBytes) {
    throw new Error(`message tronque : ${buf.byteLength} octets recus, ${minBytes} attendus`);
  }
  return new DataView(buf);
}

/**
 * Arrondit et borne un axe sur un octet signe (-127..127, -128 exclu pour
 * rester symetrique).
 *
 * ⚠️ Le client doit l'appliquer a sa visee AVANT de tirer localement, pas
 * seulement avant d'encoder : sinon il tire avec son flottant d'origine
 * pendant que le serveur ne voit que la version quantifiee, un ecart
 * systematique d'une fraction de degre.
 */
export function quantizeAxis(v: number): number {
  const r = Math.round(v);
  if (r > 127) {
    return 127;
  }
  if (r < -127) {
    return -127;
  }
  return r;
}

/** C -> S : une entree, 7 octets. */
export function encodeInput(
  seq: number,
  moveX: number,
  moveY: number,
  aimX: number,
  aimY: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(INPUT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.INPUT);
  v.setUint16(1, seq & 0xffff, true);
  v.setInt8(3, quantizeAxis(moveX));
  v.setInt8(4, quantizeAxis(moveY));
  v.setInt8(5, quantizeAxis(aimX));
  v.setInt8(6, quantizeAxis(aimY));
  return buf;
}

export function decodeInput(buf: ArrayBuffer): InputMessage {
  const v = viewOf(buf, INPUT_BYTES);
  return {
    type: MSG.INPUT,
    seq: v.getUint16(1, true),
    moveX: v.getInt8(3),
    moveY: v.getInt8(4),
    aimX: v.getInt8(5),
    aimY: v.getInt8(6),
  };
}

/**
 * S -> C : positions des joueurs, `SNAPSHOT_HEADER_BYTES` d'en-tete puis
 * `SNAPSHOT_PLAYER_BYTES` par joueur. `xp`, `synergy` et `gold` sont ceux de
 * l'equipe, dans l'en-tete.
 */
export function encodeSnapshot(
  tick: number,
  xp: number,
  synergy: number,
  players: readonly PlayerSnapshot[],
  boss: BossSnapshot | null = null,
  gold = 0,
): ArrayBuffer {
  const buf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + players.length * SNAPSHOT_PLAYER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint8(5, players.length);
  v.setUint16(6, xp, true);
  v.setUint16(8, synergy, true);
  v.setUint32(10, boss ? boss.id : NO_BOSS_ID, true);
  // ⚠️ Arrondi ET borne : `Horde.hp` est un flottant, `setUint32` tronquerait
  // vers zero sans l'arrondi et replierait modulo 2^32 sans la borne.
  v.setUint32(14, boss ? Math.min(BOSS_HP_MAX, Math.max(0, Math.round(boss.hp))) : 0, true);
  // Borne : au-dela de `GOLD_MAX`, `setUint32` replierait modulo 2^32.
  // L'arrondi couvre le multiplicateur d'extraction, seul chemin par lequel
  // l'or peut cesser d'etre entier.
  v.setUint32(18, Math.min(GOLD_MAX, Math.max(0, Math.round(gold))), true);
  let o = SNAPSHOT_HEADER_BYTES;
  for (const p of players) {
    v.setUint8(o, p.id);
    v.setInt16(o + 1, Math.round(p.x), true);
    v.setInt16(o + 3, Math.round(p.y), true);
    // ⚠️ Borne : `setUint16` applique `p.hp` modulo 2^16, et un `hp` negatif
    // partirait pres de 65536 — un mort affiche a PV quasi plein. Garde
    // independante de celle de `room.ts`, pour tout chemin futur.
    v.setUint16(o + 5, Math.min(0xffff, Math.max(0, p.hp)), true);
    v.setInt8(o + 7, quantizeAxis(p.aimX));
    v.setInt8(o + 8, quantizeAxis(p.aimY));
    v.setUint8(o + 9, Math.min(255, Math.max(0, Math.round(p.pickupRadius))));
    // Meme borne : `SHIELD_POOL` est loin sous 255, mais un champ non borne
    // replierait modulo 256 au premier chemin qui le laisserait deraper.
    v.setUint8(o + 10, Math.min(255, Math.max(0, Math.round(p.shield))));
    o += SNAPSHOT_PLAYER_BYTES;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): SnapshotMessage {
  // ⚠️ DEUX controles qui ne se couvrent pas : celui-ci n'exige que les octets
  // qui portent le nombre de joueurs annonce, le second exige tout le reste.
  const head = viewOf(buf, SNAPSHOT_COUNT_BYTES);
  const count = head.getUint8(5);
  // Le nombre de joueurs vient du buffer : on le confronte a sa taille reelle
  // avant de boucler, sinon un en-tete menteur fait lire hors des bornes.
  const v = viewOf(buf, SNAPSHOT_HEADER_BYTES + count * SNAPSHOT_PLAYER_BYTES);

  const players: PlayerSnapshot[] = [];
  let o = SNAPSHOT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    players.push({
      id: v.getUint8(o),
      x: v.getInt16(o + 1, true),
      y: v.getInt16(o + 3, true),
      hp: v.getUint16(o + 5, true),
      aimX: v.getInt8(o + 7),
      aimY: v.getInt8(o + 8),
      pickupRadius: v.getUint8(o + 9),
      shield: v.getUint8(o + 10),
    });
    o += SNAPSHOT_PLAYER_BYTES;
  }

  const bossId = v.getUint32(10, true);
  return {
    type: MSG.SNAPSHOT,
    tick: v.getUint32(1, true),
    xp: v.getUint16(6, true),
    synergy: v.getUint16(8, true),
    players,
    // La sentinelle se lit ICI et nulle part ailleurs : au-dela de cette
    // ligne, « pas de boss » est un `null`, jamais un nombre a comparer.
    boss: bossId === NO_BOSS_ID ? null : { id: bossId, hp: v.getUint32(14, true) },
    gold: v.getUint32(18, true),
  };
}

/**
 * Empaquette un couple d'elements sur UN octet : le plus petit identifiant
 * dans le quartet de poids fort, le plus grand dans celui de poids faible.
 *
 * ⚠️ **Canonique, donc insensible a l'ordre d'arrivee.** Givre sur une marque
 * Braise et Braise sur une marque Givre sont la meme reaction et doivent
 * porter le meme octet, sinon deux clients dessineraient deux flashs
 * differents et une table indexee par `pair` aurait deux entrees.
 *
 * Un quartet par element, donc seize elements possibles : `protocol.test.ts`
 * garde la marge en confrontant `ELEMENTS.length` a 16.
 */
export function packElementPair(a: number, b: number): number {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return ((lo & 0x0f) << 4) | (hi & 0x0f);
}

/** L'inverse de `packElementPair` : les deux elements, du plus petit au plus grand. */
export function unpackElementPair(pair: number): [number, number] {
  return [(pair >> 4) & 0x0f, pair & 0x0f];
}

/**
 * Ce qu'une zone porte dans l'octet `kind` : un COUPLE, sans octet de plus.
 *
 * | bits | contenu | 0 signifie |
 * | --- | --- | --- |
 * | 0-2 | l'element dont la zone MARQUE les ennemis | ne marque rien |
 * | 3-6 | le type de champ de REACTION | aucun effet de reaction |
 *
 * ⚠️ **Ne remplace PAS `ReactionTrigger.element`**, qui reste le SECOND
 * element du couple (voir son docbloc dans `back/src/combat.ts`) et evite que
 * le meme tireur redeclenche indefiniment avec une seule arme.
 *
 * Le bit 7 reste a zero. Les valeurs sont masquees : hors bornes, elles sont
 * tronquees, jamais levees.
 */
export function packZoneKind(element: number, reaction: number): number {
  return (element & 0x07) | ((reaction & 0x0f) << 3);
}

/** L'element que la zone marque (bits 0-2 de `kind`). Voir `packZoneKind`. */
export function zoneElement(kind: number): number {
  return kind & 0x07;
}

/** Le type de champ de reaction que la zone porte (bits 3-6 de `kind`). Voir `packZoneKind`. */
export function zoneReaction(kind: number): number {
  return (kind >> 3) & 0x0f;
}

/**
 * S -> C : une zone au sol vient d'etre posee, 11 octets. Voir `ZoneMessage`.
 * `kind` est DEJA empaquete par l'appelant (`packZoneKind`).
 */
export function encodeZone(
  kind: number,
  x: number,
  y: number,
  bornTick: number,
  by: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(ZONE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.ZONE);
  v.setUint8(1, kind);
  v.setInt16(2, Math.round(x), true);
  v.setInt16(4, Math.round(y), true);
  v.setUint32(6, bornTick >>> 0, true);
  v.setUint8(10, by);
  return buf;
}

/**
 * S -> C : le boss charge, 29 octets, un seul message par charge.
 *
 * ⚠️ **Prend la `BossCharge` DEJA construite** : `makeBossCharge` a arrondi
 * l'origine et quantifie la direction, et le serveur derive sa position depuis
 * ces nombres-la. Encoder autre chose ferait suivre au client un couloir
 * voisin mais different.
 */
export function encodeBossCharge(charge: Omit<BossChargeMessage, 'type'>): ArrayBuffer {
  const buf = new ArrayBuffer(BOSS_CHARGE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.BOSS_CHARGE);
  v.setUint32(1, charge.entityId >>> 0, true);
  v.setInt16(5, Math.round(charge.x), true);
  v.setInt16(7, Math.round(charge.y), true);
  v.setInt16(9, Math.round(charge.dirX * CHARGE_DIR_SCALE), true);
  v.setInt16(11, Math.round(charge.dirY * CHARGE_DIR_SCALE), true);
  v.setUint16(13, Math.round(charge.length), true);
  v.setUint16(15, Math.round(charge.width), true);
  v.setUint32(17, charge.windupTick >>> 0, true);
  v.setUint32(21, charge.startTick >>> 0, true);
  v.setUint32(25, charge.endTick >>> 0, true);
  return buf;
}

export function decodeBossCharge(buf: ArrayBuffer): BossChargeMessage {
  const v = viewOf(buf, BOSS_CHARGE_BYTES);
  return {
    type: MSG.BOSS_CHARGE,
    entityId: v.getUint32(1, true),
    x: v.getInt16(5, true),
    y: v.getInt16(7, true),
    dirX: v.getInt16(9, true) / CHARGE_DIR_SCALE,
    dirY: v.getInt16(11, true) / CHARGE_DIR_SCALE,
    length: v.getUint16(13, true),
    width: v.getUint16(15, true),
    windupTick: v.getUint32(17, true),
    startTick: v.getUint32(21, true),
    endTick: v.getUint32(25, true),
  };
}

export function decodeZone(buf: ArrayBuffer): ZoneMessage {
  const v = viewOf(buf, ZONE_BYTES);
  return {
    type: MSG.ZONE,
    kind: v.getUint8(1),
    x: v.getInt16(2, true),
    y: v.getInt16(4, true),
    bornTick: v.getUint32(6, true),
    by: v.getUint8(10),
  };
}

/** S -> C : une reaction a eu lieu, 11 octets. Voir `ReactionMessage`. */
export function encodeReaction(
  pair: number,
  x: number,
  y: number,
  tick: number,
  synergyCharge: boolean,
): ArrayBuffer {
  const buf = new ArrayBuffer(REACTION_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.REACTION);
  v.setUint8(1, pair);
  v.setInt16(2, Math.round(x), true);
  v.setInt16(4, Math.round(y), true);
  v.setUint32(6, tick >>> 0, true);
  v.setUint8(10, synergyCharge ? 1 : 0);
  return buf;
}

export function decodeReaction(buf: ArrayBuffer): ReactionMessage {
  const v = viewOf(buf, REACTION_BYTES);
  return {
    type: MSG.REACTION,
    pair: v.getUint8(1),
    x: v.getInt16(2, true),
    y: v.getInt16(4, true),
    tick: v.getUint32(6, true),
    synergyCharge: v.getUint8(10) !== 0,
  };
}

/**
 * Coeur commun de `DEATHS` et `PICKUPS` : `type u8 · tick u32 · count u16 ·
 * id u32 x count`. Le tri croissant (voir `DeathsMessage`) est impose ici
 * plutot que laisse a chaque appelant.
 */
function encodeIdBatch(type: number, tick: number, ids: readonly number[]): ArrayBuffer {
  const sorted = [...ids].sort((a, b) => a - b);
  const buf = new ArrayBuffer(DEATHS_HEADER_BYTES + sorted.length * DEATH_ID_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, type);
  v.setUint32(1, tick >>> 0, true);
  v.setUint16(5, sorted.length, true);
  let o = DEATHS_HEADER_BYTES;
  for (const id of sorted) {
    v.setUint32(o, id >>> 0, true);
    o += DEATH_ID_BYTES;
  }
  return buf;
}

function decodeIdBatch(buf: ArrayBuffer): { tick: number; ids: number[] } {
  const head = viewOf(buf, DEATHS_HEADER_BYTES);
  const count = head.getUint16(5, true);
  // Comme pour le snapshot : on confronte le compte annonce a la taille
  // reelle du buffer avant de boucler, plutot que de lire hors des bornes.
  const v = viewOf(buf, DEATHS_HEADER_BYTES + count * DEATH_ID_BYTES);

  const ids: number[] = [];
  let o = DEATHS_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    ids.push(v.getUint32(o, true));
    o += DEATH_ID_BYTES;
  }

  return { tick: v.getUint32(1, true), ids };
}

/** S -> C : identites mortes ce tick. Voir `encodeIdBatch`. */
export function encodeDeaths(tick: number, ids: readonly number[]): ArrayBuffer {
  return encodeIdBatch(MSG.DEATHS, tick, ids);
}

export function decodeDeaths(buf: ArrayBuffer): DeathsMessage {
  return { type: MSG.DEATHS, ...decodeIdBatch(buf) };
}

/** S -> C : orbes ramasses ce tick. Voir `encodeIdBatch`. */
export function encodePickups(tick: number, ids: readonly number[]): ArrayBuffer {
  return encodeIdBatch(MSG.PICKUPS, tick, ids);
}

export function decodePickups(buf: ArrayBuffer): PickupsMessage {
  return { type: MSG.PICKUPS, ...decodeIdBatch(buf) };
}

/**
 * S -> C : l'equipe atteint un nouveau niveau, 6 octets.
 *
 * `tick` est celui du gel, pas de l'emission — voir `LevelUpMessage`.
 */
export function encodeLevelUp(tick: number, level: number): ArrayBuffer {
  const buf = new ArrayBuffer(LEVEL_UP_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.LEVEL_UP);
  v.setUint32(1, tick >>> 0, true);
  v.setUint8(5, level);
  return buf;
}

export function decodeLevelUp(buf: ArrayBuffer): LevelUpMessage {
  const v = viewOf(buf, LEVEL_UP_BYTES);
  return {
    type: MSG.LEVEL_UP,
    tick: v.getUint32(1, true),
    level: v.getUint8(5),
  };
}

/** S -> C : fin de run, une seule fois, 14 octets. Voir `RunOverMessage`. */
export function encodeRunOver(
  tick: number,
  survivedTicks: number,
  level: number,
  kills: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(RUN_OVER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.RUN_OVER);
  v.setUint32(1, tick >>> 0, true);
  v.setUint32(5, survivedTicks >>> 0, true);
  v.setUint8(9, level);
  v.setUint32(10, kills >>> 0, true);
  return buf;
}

export function decodeRunOver(buf: ArrayBuffer): RunOverMessage {
  const v = viewOf(buf, RUN_OVER_BYTES);
  return {
    type: MSG.RUN_OVER,
    tick: v.getUint32(1, true),
    survivedTicks: v.getUint32(5, true),
    level: v.getUint8(9),
    kills: v.getUint32(10, true),
  };
}

/**
 * S -> C, a la connexion : l'identifiant attribue, le tick courant du salon et
 * la graine de la carte d'obstacles.
 */
export function encodeWelcome(playerId: number, tick: number, mapSeed: number): ArrayBuffer {
  const buf = new ArrayBuffer(WELCOME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WELCOME);
  v.setUint8(1, playerId);
  v.setUint32(2, tick >>> 0, true);
  v.setUint32(6, mapSeed >>> 0, true);
  return buf;
}

export function decodeWelcome(buf: ArrayBuffer): WelcomeMessage {
  const v = viewOf(buf, WELCOME_BYTES);
  return {
    type: MSG.WELCOME,
    playerId: v.getUint8(1),
    tick: v.getUint32(2, true),
    mapSeed: v.getUint32(6, true),
  };
}

/**
 * S -> C : l'ordre de faire apparaitre une vague. 19 octets, **quel que soit le
 * nombre d'entites** : on ne replique pas la horde, on replique son generateur
 * (repliquer 1 000 ennemis a 30 Hz couterait ~150 ko/s).
 *
 * Parametre structurel plutot que `WaveOrder` : le protocole ne doit pas
 * dependre de `shared/waves.ts`.
 */
export function encodeWaveOrder(order: {
  waveId: number;
  spawnTick: number;
  seed: number;
  archetype: number;
  formation: number;
  anchorX: number;
  anchorY: number;
  count: number;
}): ArrayBuffer {
  const buf = new ArrayBuffer(WAVE_ORDER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.WAVE_ORDER);
  v.setUint16(1, order.waveId & 0xffff, true);
  v.setUint32(3, order.spawnTick >>> 0, true);
  v.setUint32(7, order.seed >>> 0, true);
  v.setUint8(11, order.archetype);
  v.setUint8(12, order.formation);
  v.setInt16(13, Math.round(order.anchorX), true);
  v.setInt16(15, Math.round(order.anchorY), true);
  v.setUint16(17, order.count & 0xffff, true);
  return buf;
}

export function decodeWaveOrder(buf: ArrayBuffer): WaveOrderMessage {
  const v = viewOf(buf, WAVE_ORDER_BYTES);
  return {
    type: MSG.WAVE_ORDER,
    waveId: v.getUint16(1, true),
    spawnTick: v.getUint32(3, true),
    seed: v.getUint32(7, true),
    archetype: v.getUint8(11),
    formation: v.getUint8(12),
    anchorX: v.getInt16(13, true),
    anchorY: v.getInt16(15, true),
    count: v.getUint16(17, true),
  };
}

/** Lit le premier octet et aiguille. */
export function decode(buf: ArrayBuffer): Message {
  const v = viewOf(buf, 1);
  const type = v.getUint8(0);
  switch (type) {
    case MSG.WELCOME:
      return decodeWelcome(buf);
    case MSG.SNAPSHOT:
      return decodeSnapshot(buf);
    case MSG.INPUT:
      return decodeInput(buf);
    case MSG.WAVE_ORDER:
      return decodeWaveOrder(buf);
    case MSG.DEATHS:
      return decodeDeaths(buf);
    case MSG.PICKUPS:
      return decodePickups(buf);
    case MSG.LEVEL_UP:
      return decodeLevelUp(buf);
    case MSG.RUN_OVER:
      return decodeRunOver(buf);
    case MSG.DRAFT_OPEN:
      return decodeDraftOpen(buf);
    case MSG.DRAFT_TOKEN:
      return decodeDraftToken(buf);
    case MSG.DRAFT_INTENTS:
      return decodeDraftIntents(buf);
    case MSG.DRAFT_RESULT:
      return decodeDraftResult(buf);
    case MSG.ZONE:
      return decodeZone(buf);
    case MSG.REACTION:
      return decodeReaction(buf);
    case MSG.BOSS_CHARGE:
      return decodeBossCharge(buf);
    case MSG.PORTAL_OPEN:
      return decodePortalOpen(buf);
    case MSG.HELLO:
      return decodeHello(buf);
    case MSG.VOTE:
      return decodeVote(buf);
    case MSG.VOTES:
      return decodeVotes(buf);
    case MSG.PORTAL_RESULT:
      return decodePortalResult(buf);
    case MSG.LOBBY:
      return decodeLobby(buf);
    case MSG.PICK: {
      const pv = viewOf(buf, PICK_BYTES);
      return { type: MSG.PICK, weaponId: pv.getUint8(1), classId: pv.getUint8(2) };
    }
    case MSG.START:
      return { type: MSG.START };
    case MSG.ABILITY:
      return decodeAbility(buf);
    case MSG.ABILITY_USED:
      return decodeAbilityUsed(buf);
    case MSG.PING:
      return decodePing(buf);
    case MSG.PING_SHOWN:
      return decodePingShown(buf);
    default:
      throw new Error(`type de message inconnu : ${type}`);
  }
}

/** Une carte de l'etalage, telle qu'elle transite. Miroir de `Card` de `shared/cards.ts`. */
export interface WireCard {
  nature: number;
  refId: number;
  upgrade?: number;
  /** La rarete (`RARITY`). Absente : commune. */
  rarity?: number;
}

/**
 * S -> C : l'etalage s'ouvre.
 *
 * `deadlineTick` est l'echeance de la fenetre. En solo elle ne s'applique pas —
 * le gel se referme au jeton pose — mais le champ reste renseigne pour que le
 * client n'ait pas deux chemins de lecture.
 */
export function encodeDraftOpen(deadlineTick: number, cards: readonly WireCard[]): ArrayBuffer {
  const buf = new ArrayBuffer(DRAFT_OPEN_HEADER_BYTES + cards.length * DRAFT_CARD_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.DRAFT_OPEN);
  v.setUint32(1, deadlineTick >>> 0, true);
  v.setUint8(5, cards.length);
  let o = DRAFT_OPEN_HEADER_BYTES;
  for (const c of cards) {
    v.setUint8(o, c.nature);
    v.setUint8(o + 1, c.refId);
    v.setUint8(o + 2, c.upgrade ?? 0);
    v.setUint8(o + 3, c.rarity ?? 0);
    o += DRAFT_CARD_BYTES;
  }
  return buf;
}

/** C -> S : je pose mon jeton, ou je le retire (`NO_TOKEN`). */
export function encodeDraftToken(cardIndex: number): ArrayBuffer {
  const buf = new ArrayBuffer(DRAFT_TOKEN_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.DRAFT_TOKEN);
  v.setUint8(1, cardIndex);
  return buf;
}

/** Une intention diffusee : qui vise quoi. */
export interface WireIntent {
  playerId: number;
  cardIndex: number;
}

/**
 * S -> C : qui a pose sur quoi. Le seul message du draft a cadence soutenue :
 * sans cette visibilite, la negociation n'existe pas.
 */
export function encodeDraftIntents(intents: readonly WireIntent[]): ArrayBuffer {
  const buf = new ArrayBuffer(DRAFT_INTENTS_HEADER_BYTES + intents.length * DRAFT_INTENT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.DRAFT_INTENTS);
  v.setUint8(1, intents.length);
  let o = DRAFT_INTENTS_HEADER_BYTES;
  for (const i of intents) {
    v.setUint8(o, i.playerId);
    v.setUint8(o + 1, i.cardIndex);
    o += DRAFT_INTENT_BYTES;
  }
  return buf;
}

/** L'issue d'un joueur : `0` obtenue, `1` perdue au conflit, `2` attribuee d'office. */
export interface WireOutcome {
  playerId: number;
  cardIndex: number;
  outcome: number;
}

/**
 * S -> C : la resolution, une fois par draft.
 *
 * ⚠️ **`deadlineTick` porte la fin du gel**, que le client ne peut pas
 * deduire : la fenetre dure jusqu'a ce que tout le monde ait pose son jeton,
 * et en solo elle se ferme au clic.
 */
export function encodeDraftResult(
  deadlineTick: number,
  outcomes: readonly WireOutcome[],
): ArrayBuffer {
  const buf = new ArrayBuffer(DRAFT_RESULT_HEADER_BYTES + outcomes.length * DRAFT_OUTCOME_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.DRAFT_RESULT);
  v.setUint32(1, deadlineTick >>> 0, true);
  v.setUint8(5, outcomes.length);
  let o = DRAFT_RESULT_HEADER_BYTES;
  for (const r of outcomes) {
    v.setUint8(o, r.playerId);
    v.setUint8(o + 1, r.cardIndex);
    v.setUint8(o + 2, r.outcome);
    o += DRAFT_OUTCOME_BYTES;
  }
  return buf;
}

/**
 * S -> C : le portail s'ouvre, jusqu'a `deadlineTick`. Aucun gel : voir
 * `PortalOpenMessage`.
 */
export function encodePortalOpen(deadlineTick: number, multiplier: number): ArrayBuffer {
  const buf = new ArrayBuffer(PORTAL_OPEN_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PORTAL_OPEN);
  v.setUint32(1, deadlineTick >>> 0, true);
  // Borne et arrondi explicites : sans la borne, `setUint16` replierait modulo
  // 2^16. Voir `EXTRACT_MULTIPLIER_SCALE`.
  const cents = Math.round(multiplier * EXTRACT_MULTIPLIER_SCALE);
  v.setUint16(5, Math.min(0xffff, Math.max(0, cents)), true);
  return buf;
}

/**
 * C -> S : presente le jeton de compte.
 *
 * ⚠️ **Leve si le jeton ne fait pas exactement `TOKEN_BYTES`** : un jeton trop
 * court donnerait un message de la bonne taille complete par des zeros, puis
 * un refus d'authentification inexplicable loin de sa cause.
 */
export function encodeHello(token: Uint8Array): ArrayBuffer {
  if (token.length !== TOKEN_BYTES) {
    throw new Error(`jeton de ${token.length} octets, ${TOKEN_BYTES} attendus`);
  }
  const buf = new ArrayBuffer(HELLO_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.HELLO);
  new Uint8Array(buf, 1, TOKEN_BYTES).set(token);
  return buf;
}

function decodeHello(buf: ArrayBuffer): HelloMessage {
  viewOf(buf, HELLO_BYTES);
  return { type: MSG.HELLO, token: new Uint8Array(buf.slice(1, HELLO_BYTES)) };
}

/** C -> S : je vote, ou je retire mon vote (`NO_VOTE`). */
export function encodeVote(choice: number): ArrayBuffer {
  const buf = new ArrayBuffer(VOTE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.VOTE);
  v.setUint8(1, choice);
  return buf;
}

/** S -> C : qui a vote quoi. Voir `VotesMessage`. */
export function encodeVotes(votes: readonly WireVote[]): ArrayBuffer {
  const buf = new ArrayBuffer(VOTES_HEADER_BYTES + votes.length * VOTE_ENTRY_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.VOTES);
  v.setUint8(1, votes.length);
  let o = VOTES_HEADER_BYTES;
  for (const w of votes) {
    v.setUint8(o, w.playerId);
    v.setUint8(o + 1, w.choice);
    o += VOTE_ENTRY_BYTES;
  }
  return buf;
}

/** S -> C : le portail a tranche. Voir `PortalResultMessage`. */
export function encodePortalResult(
  effectTick: number,
  decision: number,
  gold: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(PORTAL_RESULT_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PORTAL_RESULT);
  v.setUint32(1, effectTick >>> 0, true);
  v.setUint8(5, decision);
  // Meme borne et meme arrondi que dans `encodeSnapshot` : c'est le meme
  // nombre, il ne peut pas se replier d'un cote et pas de l'autre.
  v.setUint32(6, Math.min(GOLD_MAX, Math.max(0, Math.round(gold))), true);
  return buf;
}

function decodePortalOpen(buf: ArrayBuffer): PortalOpenMessage {
  const v = viewOf(buf, PORTAL_OPEN_BYTES);
  return {
    type: MSG.PORTAL_OPEN,
    deadlineTick: v.getUint32(1, true),
    multiplier: v.getUint16(5, true) / EXTRACT_MULTIPLIER_SCALE,
  };
}

function decodeVote(buf: ArrayBuffer): VoteMessage {
  const v = viewOf(buf, VOTE_BYTES);
  return { type: MSG.VOTE, choice: v.getUint8(1) };
}

function decodeVotes(buf: ArrayBuffer): VotesMessage {
  const v = viewOf(buf, VOTES_HEADER_BYTES);
  const count = v.getUint8(1);
  viewOf(buf, VOTES_HEADER_BYTES + count * VOTE_ENTRY_BYTES);
  const votes: WireVote[] = [];
  let o = VOTES_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    votes.push({ playerId: v.getUint8(o), choice: v.getUint8(o + 1) });
    o += VOTE_ENTRY_BYTES;
  }
  return { type: MSG.VOTES, votes };
}

function decodePortalResult(buf: ArrayBuffer): PortalResultMessage {
  const v = viewOf(buf, PORTAL_RESULT_BYTES);
  return {
    type: MSG.PORTAL_RESULT,
    effectTick: v.getUint32(1, true),
    decision: v.getUint8(5),
    gold: v.getUint32(6, true),
  };
}

function decodeDraftOpen(buf: ArrayBuffer): DraftOpenMessage {
  const v = viewOf(buf, DRAFT_OPEN_HEADER_BYTES);
  const count = v.getUint8(5);
  viewOf(buf, DRAFT_OPEN_HEADER_BYTES + count * DRAFT_CARD_BYTES);
  const cards: WireCard[] = [];
  let o = DRAFT_OPEN_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    cards.push({
      nature: v.getUint8(o),
      refId: v.getUint8(o + 1),
      upgrade: v.getUint8(o + 2),
      rarity: v.getUint8(o + 3),
    });
    o += DRAFT_CARD_BYTES;
  }
  return { type: MSG.DRAFT_OPEN, deadlineTick: v.getUint32(1, true), cards };
}

function decodeDraftToken(buf: ArrayBuffer): DraftTokenMessage {
  const v = viewOf(buf, DRAFT_TOKEN_BYTES);
  return { type: MSG.DRAFT_TOKEN, cardIndex: v.getUint8(1) };
}

function decodeDraftIntents(buf: ArrayBuffer): DraftIntentsMessage {
  const v = viewOf(buf, DRAFT_INTENTS_HEADER_BYTES);
  const count = v.getUint8(1);
  viewOf(buf, DRAFT_INTENTS_HEADER_BYTES + count * DRAFT_INTENT_BYTES);
  const intents: WireIntent[] = [];
  let o = DRAFT_INTENTS_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    intents.push({ playerId: v.getUint8(o), cardIndex: v.getUint8(o + 1) });
    o += DRAFT_INTENT_BYTES;
  }
  return { type: MSG.DRAFT_INTENTS, intents };
}

function decodeDraftResult(buf: ArrayBuffer): DraftResultMessage {
  const v = viewOf(buf, DRAFT_RESULT_HEADER_BYTES);
  const count = v.getUint8(5);
  viewOf(buf, DRAFT_RESULT_HEADER_BYTES + count * DRAFT_OUTCOME_BYTES);
  const outcomes: WireOutcome[] = [];
  let o = DRAFT_RESULT_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    outcomes.push({
      playerId: v.getUint8(o),
      cardIndex: v.getUint8(o + 1),
      outcome: v.getUint8(o + 2),
    });
    o += DRAFT_OUTCOME_BYTES;
  }
  return {
    type: MSG.DRAFT_RESULT,
    deadlineTick: v.getUint32(1, true),
    outcomes,
  };
}

/**
 * Salle d'attente : avant `START`, le salon n'existe que comme liste de joueurs
 * et de leur arme de depart choisie. Aucun tick ne tourne, aucun `WELCOME`
 * n'est envoye — c'est `START` qui ouvre la run.
 */

/** Pas d'arme de depart choisie : la run commence avec la seule arme neutre. */
export const NO_WEAPON = 255;

/** Un joueur de la salle d'attente. */
export interface LobbyEntry {
  playerId: number;
  /** Arme de depart choisie, ou `NO_WEAPON`. */
  weaponId: number;
  /** Classe choisie (voir `shared/classes.ts`), `DEFAULT_CLASS_ID` si rien choisi. */
  classId: number;
}

/**
 * S -> C : l'etat de la salle d'attente, rediffuse a chaque changement.
 *
 * L'hote est le PREMIER de `players` (le plus petit identifiant) : seul lui
 * peut lancer. Pas d'octet pour le dire, l'ordre suffit.
 */
export interface LobbyMessage {
  type: typeof MSG.LOBBY;
  /** Le slot de CE destinataire. */
  you: number;
  players: LobbyEntry[];
}

/**
 * C -> S : je choisis cette arme de depart (`NO_WEAPON` pour aucune) et cette
 * classe. Les deux choix sont arbitres independamment cote serveur.
 */
export interface PickMessage {
  type: typeof MSG.PICK;
  weaponId: number;
  classId: number;
}

/** C -> S : l'hote lance la run. */
export interface StartMessage {
  type: typeof MSG.START;
}

/**
 * C -> S : le joueur demande son verbe.
 *
 * ⚠️ **Le joueur ne dit PAS quel verbe** : il n'en a qu'un, celui de sa classe,
 * et c'est le salon qui le lit. Laisser le client nommer son verbe l'autoriserait
 * a demander celui d'une autre classe.
 */
export interface AbilityMessage {
  type: typeof MSG.ABILITY;
  tick: number;
  aimX: number;
  aimY: number;
}

/**
 * S -> C : le salon ANNONCE un verbe accepte.
 *
 * ⚠️ **L'annonce, jamais l'effet** : les deux cotes derivent l'effet de ces
 * parametres et de ce tick, comme pour `BOSS_CHARGE` (scenario 11c de
 * `shared/horde.replication.test.ts`).
 */
export interface AbilityUsedMessage {
  type: typeof MSG.ABILITY_USED;
  tick: number;
  playerId: number;
  verb: number;
  x: number;
  y: number;
  /** La cible d'un Relais ; `0` pour les verbes qui n'en ont pas. */
  targetId: number;
}

/** `type u8 · you u8 · count u8`. */
export const LOBBY_HEADER_BYTES = 3;
/** Une entree : `playerId u8 · weaponId u8 · classId u8`. */
export const LOBBY_ENTRY_BYTES = 3;
/** `type u8 · weaponId u8 · classId u8`. */
export const PICK_BYTES = 3;

export function encodeLobby(you: number, players: readonly LobbyEntry[]): ArrayBuffer {
  const buf = new ArrayBuffer(LOBBY_HEADER_BYTES + players.length * LOBBY_ENTRY_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.LOBBY);
  v.setUint8(1, you);
  v.setUint8(2, players.length);
  let o = LOBBY_HEADER_BYTES;
  for (const p of players) {
    v.setUint8(o, p.playerId);
    v.setUint8(o + 1, p.weaponId);
    v.setUint8(o + 2, p.classId);
    o += LOBBY_ENTRY_BYTES;
  }
  return buf;
}

function decodeLobby(buf: ArrayBuffer): LobbyMessage {
  const v = viewOf(buf, LOBBY_HEADER_BYTES);
  const count = v.getUint8(2);
  viewOf(buf, LOBBY_HEADER_BYTES + count * LOBBY_ENTRY_BYTES);
  const players: LobbyEntry[] = [];
  let o = LOBBY_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    players.push({
      playerId: v.getUint8(o),
      weaponId: v.getUint8(o + 1),
      classId: v.getUint8(o + 2),
    });
    o += LOBBY_ENTRY_BYTES;
  }
  return { type: MSG.LOBBY, you: v.getUint8(1), players };
}

export function encodePick(weaponId: number, classId: number): ArrayBuffer {
  const buf = new ArrayBuffer(PICK_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PICK);
  v.setUint8(1, weaponId);
  v.setUint8(2, classId);
  return buf;
}

export function encodeStart(): ArrayBuffer {
  const buf = new ArrayBuffer(1);
  new DataView(buf).setUint8(0, MSG.START);
  return buf;
}

/** `type u8 · tick u32 · aimX i16 · aimY i16`. */
export const ABILITY_BYTES = 9;

export function encodeAbility(tick: number, aimX: number, aimY: number): ArrayBuffer {
  const buf = new ArrayBuffer(ABILITY_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.ABILITY);
  v.setUint32(1, tick, true);
  v.setInt16(5, Math.round(aimX), true);
  v.setInt16(7, Math.round(aimY), true);
  return buf;
}

export function decodeAbility(buf: ArrayBuffer): AbilityMessage {
  const v = viewOf(buf, ABILITY_BYTES);
  return {
    type: MSG.ABILITY,
    tick: v.getUint32(1, true),
    aimX: v.getInt16(5, true),
    aimY: v.getInt16(7, true),
  };
}

/**
 * `type u8 · tick u32 · playerId u8 · verb u8 · x i16 · y i16 · targetId u8`,
 * sans octet de reserve.
 */
export const ABILITY_USED_BYTES = 12;

export function encodeAbilityUsed(
  tick: number,
  playerId: number,
  verb: number,
  x: number,
  y: number,
  targetId: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(ABILITY_USED_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.ABILITY_USED);
  v.setUint32(1, tick, true);
  v.setUint8(5, playerId);
  v.setUint8(6, verb);
  v.setInt16(7, Math.round(x), true);
  v.setInt16(9, Math.round(y), true);
  v.setUint8(11, targetId);
  return buf;
}

export function decodeAbilityUsed(buf: ArrayBuffer): AbilityUsedMessage {
  const v = viewOf(buf, ABILITY_USED_BYTES);
  return {
    type: MSG.ABILITY_USED,
    tick: v.getUint32(1, true),
    playerId: v.getUint8(5),
    verb: v.getUint8(6),
    x: v.getInt16(7, true),
    y: v.getInt16(9, true),
    targetId: v.getUint8(11),
  };
}

/**
 * C -> S : le joueur pose un ping. `type u8 · intent u8 · x i16 · y i16`.
 *
 * ⚠️ **Un evenement, jamais un etat** : rien n'entre dans `SNAPSHOT`.
 * L'intention n'est PAS validee ici : c'est le salon qui refuse une intention
 * hors de `PING_INTENTS`.
 */
export interface PingMessage {
  type: typeof MSG.PING;
  intent: number;
  x: number;
  y: number;
}

/** S -> C : le salon annonce un ping accepte, a tous, emetteur compris, 7 octets. */
export interface PingShownMessage {
  type: typeof MSG.PING_SHOWN;
  playerId: number;
  intent: number;
  x: number;
  y: number;
}

export const PING_BYTES = 6;
export const PING_SHOWN_BYTES = 7;

export function encodePing(intent: number, x: number, y: number): ArrayBuffer {
  const buf = new ArrayBuffer(PING_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PING);
  v.setUint8(1, intent);
  v.setInt16(2, Math.round(x), true);
  v.setInt16(4, Math.round(y), true);
  return buf;
}

function decodePing(buf: ArrayBuffer): PingMessage {
  const v = viewOf(buf, PING_BYTES);
  return {
    type: MSG.PING,
    intent: v.getUint8(1),
    x: v.getInt16(2, true),
    y: v.getInt16(4, true),
  };
}

export function encodePingShown(
  playerId: number,
  intent: number,
  x: number,
  y: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(PING_SHOWN_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PING_SHOWN);
  v.setUint8(1, playerId);
  v.setUint8(2, intent);
  v.setInt16(3, Math.round(x), true);
  v.setInt16(5, Math.round(y), true);
  return buf;
}

function decodePingShown(buf: ArrayBuffer): PingShownMessage {
  const v = viewOf(buf, PING_SHOWN_BYTES);
  return {
    type: MSG.PING_SHOWN,
    playerId: v.getUint8(1),
    intent: v.getUint8(2),
    x: v.getInt16(3, true),
    y: v.getInt16(5, true),
  };
}
