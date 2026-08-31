/**
 * Protocole binaire, jamais de JSON sur la boucle de jeu (§3.6 de la spec).
 *
 * Le choix est pris des le premier jour parce que retrofitter du binaire sur un
 * protocole JSON coute systematiquement plus cher que de commencer binaire.
 *
 * Tout est en little-endian : c'est l'ordre natif de x86 et d'ARM, donc aucun
 * echange d'octets a l'encodage comme au decodage.
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
} as const;

export type MsgType = (typeof MSG)[keyof typeof MSG];

/**
 * Position d'un joueur telle qu'elle passe sur le fil : quantifiee a l'entier.
 *
 * `hp` n'existe pas encore cote serveur (la tache 9 le fait vivre) : cette
 * version cable seulement le transport, `Room` le remplit avec `PLAYER_MAX_HP`.
 *
 * Pas de `xp` ici : l'experience est **celle de l'equipe**, pas d'un joueur
 * (§2 de la spec d'orientation — un seul etalage de cartes pour tout le
 * monde). La porter par joueur creerait deux sources de verite pour un seul
 * nombre ; elle vit dans `SnapshotMessage.xp`.
 *
 * `aimX`/`aimY` (tache 13) : la direction de visee de CE joueur, quantifiee
 * sur un octet signe, exactement comme elle a transite dans son `INPUT`. Le
 * `SNAPSHOT` la redistribue a tous parce que chaque client derive aussi les
 * salves de ses allies pour les dessiner (§5.2/§5.3 revus) — sans leur visee,
 * il ne saurait pas ou poser leurs projectiles. `(0, 0)` signifie « ce joueur
 * ne tire pas », jamais une direction par defaut.
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
   * Charge du compteur de Synergie de l'EQUIPE (§7 de l'etape 5a), sur deux
   * octets, exactement comme `xp` et pour la meme raison.
   *
   * ⚠️ **Un seul nombre pour l'equipe, jamais un par joueur.** Le §7 le dit
   * mot pour mot : *« la barre est une donnee d'equipe, comme l'experience de
   * l'etape 3 : un seul nombre dans le snapshot »*. Le porter dans
   * `PlayerSnapshot` creerait deux sources de verite pour un seul nombre —
   * l'erreur que l'etape 3 a faite avec l'experience, signalee a l'epoque par
   * l'implementeur, et qui a valu son deplacement dans l'en-tete.
   */
  synergy: number;
  players: PlayerSnapshot[];
  /**
   * Le boss du palier en cours, `null` quand aucun n'est en jeu.
   *
   * ⚠️ **La seule donnee PAR ENTITE que ce fil transporte, et c'est le NOMBRE
   * qui l'autorise.** Le §1.1 de la spec de l'etape 6a : *« un boss par palier,
   * jamais plus d'un vivant [...] c'est precisement parce qu'ils sont PEU que
   * les joueurs sont repliques et que la horde ne l'est pas. Le boss est du
   * cote des joueurs, pas du cote de la horde. »*
   *
   * ⚠️ **LA REGLE QUI NE DOIT PAS PLIER, et elle est ecrite ici plutot que
   * dans un document** : le jour ou un palier fera apparaitre dix boss, ce ne
   * sera plus un boss mais de la pietaille d'elite, et sa vie redeviendra
   * SERVEUR SEUL. Ce champ n'est pas un tableau et ne doit pas le devenir : dix
   * blocs par snapshot rouvriraient le contrat de replication que quatre etapes
   * tiennent. Ce qui remplacerait ce champ, alors, c'est rien du tout — le
   * client apprend deja les morts par `DEATHS` et n'a jamais eu besoin des PV
   * de la horde.
   */
  boss: BossSnapshot | null;
}

/**
 * Le boss vivant, tel que le `SNAPSHOT` le transporte : son identite et ses
 * points de vie, une fois par tick.
 *
 * ⚠️ **Son identite est une identite d'entite ordinaire** — `waveId *
 * MAX_PER_WAVE + index`, la meme arithmetique que `DEATHS` transporte depuis
 * l'etape 3. Le client peut donc la comparer a ce qu'il fait naitre, sans rien
 * apprendre de nouveau.
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
   * Direction de visee (tache 13), en coordonnees MONDE, deja normalisee cote
   * client puis quantifiee sur un octet signe — jamais derivable comme le
   * ciblage automatique du §5.3 d'origine, elle vient de la souris et doit
   * donc transiter. `(0, 0)` : le joueur ne tire pas ce tick (curseur pile
   * sur lui, ou souris jamais bougee) — voir `PlayerSnapshot`.
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
 * `DEATHS` et `PICKUPS` partagent exactement cette forme (voir `encodeIdBatch`
 * / `decodeIdBatch`) : ils ne different que par leur octet de type. Les
 * identites sont **triees en ordre croissant** — c'est l'ordre canonique
 * d'application, celui qui garantit que deux clients recevant le meme lot en
 * tirent des tableaux identiques.
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
 * S -> C : l'equipe atteint un nouveau niveau.
 *
 * Pas de `playerId` : l'experience est celle de l'equipe, pas d'un joueur
 * (§2 de la spec d'orientation — un seul etalage de cartes pour tout le
 * monde). Personne ne monte de niveau individuellement.
 *
 * ⚠️ `tick` est celui auquel le **gel** prend effet, pas celui de l'emission —
 * la meme raison que pour `DeathsMessage.tick` : sans ce tick partage, chaque
 * client figerait a la reception, donc a un tick different selon sa latence,
 * et le gel deviendrait une source de divergence au lieu d'une pause commune.
 */
export interface LevelUpMessage {
  type: typeof MSG.LEVEL_UP;
  tick: number;
  level: number;
}

/**
 * S -> C : fin de run, une seule fois. `kills` tient sur 32 bits — une run
 * longue depasse 65 535 ennemis tues, et le message ne part qu'une fois par
 * run, donc son cout n'a pas a etre minimise au meme titre qu'un message
 * frequent.
 */
export interface RunOverMessage {
  type: typeof MSG.RUN_OVER;
  tick: number;
  survivedTicks: number;
  level: number;
  kills: number;
}

/**
 * S -> C : une zone au sol vient d'etre posee (§5.3 de l'etape 5a).
 *
 * Annoncee A LA CREATION parce que le client ne peut pas savoir ou finit un
 * projectile serveur : les siens sont cosmetiques depuis l'etape 3, tires
 * depuis une position predite puis reconciliee. Une zone derivee localement
 * deriverait de quelques pixels, et deux zones qui se recouvrent d'un pixel
 * decident d'une reaction.
 *
 * ⚠️ **La MORT d'une zone n'est JAMAIS annoncee.** Elle se derive de
 * `bornTick` et de `ZONE_LIFETIME_TICKS`, des deux cotes — c'est le modele de
 * `ORB_LIFETIME_TICKS` depuis l'etape 3 (§6.1) et celui de `ZoneField.expire`.
 * Un `ZONE_GONE` doublerait le trafic des zones pour une information que les
 * deux cotes calculent deja.
 *
 * ⚠️ **Pas de rayon sur le fil.** Toutes les zones portent `ZONE_RADIUS`, une
 * constante de `shared/` que les deux cotes lisent — l'annoncer en ferait une
 * seconde source de verite pour un seul nombre. Le jour ou une zone portera un
 * rayon propre, c'est un octet de plus, pas un changement de modele.
 *
 * `by` est l'indice du joueur qui l'a posee : c'est lui que la Synergie du §7
 * compare a celui de la marque.
 */
export interface ZoneMessage {
  type: typeof MSG.ZONE;
  /** Index dans `ELEMENTS` de `shared/elements.ts`. */
  element: number;
  x: number;
  y: number;
  /** Tick de la pose. La peremption s'en derive, elle n'est pas annoncee. */
  bornTick: number;
  /** Identifiant du joueur a l'origine de la zone. */
  by: number;
}

/**
 * S -> C : une reaction a eu lieu (§6 de l'etape 5a).
 *
 * Elle est arbitree par le serveur et annoncee parce qu'elle **tue** — a la
 * difference de la teinte elementaire, qui est cosmetique et que le client
 * approxime (§2 de la spec).
 *
 * ⚠️ **La charge de Synergie voyage ICI, pas dans un message a part** (§8) :
 * les deux arrivent toujours ensemble, et un second message ne porterait rien
 * de plus.
 *
 * ⚠️ **Le message ne porte PAS les deux identifiants de joueurs**, bien que le
 * §6.1 de la spec l'annonce ainsi. Le §7 est explicite sur l'usage : c'est le
 * SERVEUR qui compare le joueur de la marque et celui du declencheur, et la
 * comparaison ne rend qu'un booleen. Le total de la barre voyage dans le
 * `SNAPSHOT`. Le client n'a donc rien a faire de deux identites qu'il ne
 * pourrait que recomparer — et les envoyer inviterait a refaire l'arbitrage
 * cote client, donc a le faire diverger.
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
  | ReactionMessage;

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

export const WELCOME_BYTES = 10;
/** `type u8 · seq u16 · moveX i8 · moveY i8 · aimX i8 · aimY i8` (tache 13 : 5 -> 7). */
export const INPUT_BYTES = 7;
/**
 * `type u8 · tick u32 · playerCount u8 · xp u16 · synergy u16 · bossId u32 ·
 * bossHp u32` — xp et synergy sont ceux de l'EQUIPE (tache 5 de l'etape 5a :
 * 8 -> 10), le boss vient de la tache 4 de l'etape 6a (10 -> 18).
 *
 * Les nombres d'equipe vivent dans l'en-tete plutot que d'etre repetes — et
 * donc potentiellement divergents — dans chaque bloc joueur. Deux octets par
 * snapshot, quel que soit le nombre de joueurs ; les porter par joueur en
 * couterait deux par joueur pour la meme information recopiee. **Le boss suit
 * la meme regle pour la meme raison** : il est UN (§1.1), donc il est du cote
 * de l'en-tete.
 *
 * ⚠️ **`bossHp` EST UN u32, ET LA LARGEUR A ETE CALCULEE, PAS DEVINEE.** La
 * lecon de l'etape 4 est ecrite deux paragraphes plus bas : le `hp` du joueur
 * etait un `u8`, la huitieme carte de vitalite l'a pousse a 260, et il se
 * repliait EN SILENCE a 4 PV. Le calcul, ici : le boss vaut
 * `BOSS_HP_PER_PLAYER x 1,12^k x joueurs`, soit **6 000 PV** au palier 0 a
 * effectif plein, et il croit en `1,12^k` sans plafond.
 *
 * | Largeur | Deborde au palier | Soit, a ~5 min par palier |
 * | --- | --- | --- |
 * | `u8` (255) | **0** — des le premier boss | jamais tenable |
 * | `u16` (65 535) | **22** | 1,8 h de jeu |
 * | **`u32` (4 294 967 295)** | **119** | 9,9 h |
 *
 * ⚠️ **Le `u16` est refuse parce que le palier 22 est ATTEIGNABLE.** Rien ne
 * borne le palier — c'est le §3 de la spec qui en fait *« la duree de vie du
 * jeu »* — et une soiree longue y arrive. Un `u16` aurait replie le boss du
 * palier 22 a 7 000 PV en silence : le meme defaut qu'a l'etape 4, au meme
 * endroit du meme fichier. Les deux octets de plus coutent
 * `2 x SNAPSHOT_HZ` octets par seconde et par client, sur un trafic mesure a
 * 1,22 ko/s a l'etape 4. Au palier 119 le boss a 4,3 milliards de PV et le jeu
 * a cesse d'etre jouable bien avant ; `encodeSnapshot` y borne explicitement
 * plutot que de laisser `setUint32` replier, et un test le dit.
 */
export const SNAPSHOT_HEADER_BYTES = 18;

/**
 * Octets qu'il faut avoir recus pour connaitre le nombre de joueurs annonce :
 * `type u8 · tick u32 · playerCount u8`.
 *
 * ⚠️ **Ce n'est PAS une seconde ecriture de `SNAPSHOT_HEADER_BYTES`** — c'est
 * la borne du premier des deux controles de `decodeSnapshot`, et elle vaut
 * exactement ce qu'il faut lire pour dimensionner le second. Voir le
 * commentaire de `decodeSnapshot`.
 */
const SNAPSHOT_COUNT_BYTES = 6;

/**
 * « Aucun boss en jeu. »
 *
 * ⚠️ **Zero ne peut PAS etre une identite d'entite, et c'est la seule raison
 * pour laquelle c'est la bonne sentinelle.** Les identites valent
 * `waveId * MAX_PER_WAVE + index` (`shared/horde.ts`) avec un `waveId` qui
 * commence a **1** — la plus petite identite possible vaut donc
 * `MAX_PER_WAVE` (4 096), et tout l'intervalle `0..4095` est inhabitable. Un
 * test le derive de `entityIdOf`, il ne le suppose pas.
 *
 * Meme regle que `NO_TOKEN = 255` a l'etape 4, choisi parce que la carte 0 est
 * une carte REELLE : une sentinelle n'est utilisable que si sa valeur ne
 * designe rien de reel.
 *
 * ⚠️ **La sentinelle est sur l'IDENTITE, jamais sur les PV.** Un boss a 0 PV
 * est un boss (il meurt au tick suivant, par `DEATHS`, comme tout le monde) —
 * lire « pas de boss » dans un `hp` nul ferait disparaitre sa barre juste
 * avant sa mort.
 */
export const NO_BOSS_ID = 0;

/** Plus grande valeur que `bossHp` peut porter : voir `SNAPSHOT_HEADER_BYTES`. */
export const BOSS_HP_MAX = 0xffff_ffff;
/**
 * `id u8 · x i16 · y i16 · hp u16 · aimX i8 · aimY i8` — pas de xp ici, voir
 * `PlayerSnapshot`. Tache 13 de l'etape 3 : 6 -> 8 ; tache 8 de l'etape 4 :
 * 8 -> 9.
 *
 * ⚠️ **`hp` est passe de `u8` a `u16` a la tache 8 de l'etape 4**, et ce
 * n'etait pas prevu au plan. Le passif « vitalite » ajoute 20 points de vie
 * maximum par carte : a partir de la huitieme (100 + 8 * 20 = 260), un `u8`
 * repliait silencieusement le joueur a 4 points de vie. Un plafond a 255
 * aurait rendu la carte inerte sans le dire. L'octet supplementaire par joueur
 * et par snapshot coute moins de 1 % du trafic mesure a l'etape 3
 * (1,09 ko/s par joueur).
 */
export const SNAPSHOT_PLAYER_BYTES = 9;
export const WAVE_ORDER_BYTES = 19;

/** En-tete commun a `DEATHS` et `PICKUPS` : type u8, tick u32, count u16. */
export const DEATHS_HEADER_BYTES = 7;
/** `type u8 · deadlineTick u32 · count u8`. */
export const DRAFT_OPEN_HEADER_BYTES = 6;
/** Une carte : `nature u8 · refId u8`. */
export const DRAFT_CARD_BYTES = 2;
/** `type u8 · cardIndex u8`. */
export const DRAFT_TOKEN_BYTES = 2;
/** `type u8 · count u8`. */
export const DRAFT_INTENTS_HEADER_BYTES = 2;
/** Une intention : `playerId u8 · cardIndex u8`. */
export const DRAFT_INTENT_BYTES = 2;
/**
 * `type u8 · deadlineTick u32 · count u8`.
 *
 * ⚠️ **Il y avait un octet `phase` de plus.** Il distinguait « le draft est
 * termine » de « une repioche s'ouvre » ; la repioche n'existe plus, la
 * resolution est un seul moment, donc le message n'a plus qu'un sens possible.
 */
export const DRAFT_RESULT_HEADER_BYTES = 6;
/** Une issue : `playerId u8 · cardIndex u8 · outcome u8`. */
export const DRAFT_OUTCOME_BYTES = 3;

/**
 * Ce qui est arrive a un joueur, tel que l'octet `outcome` de `DRAFT_RESULT`
 * le transporte (§4.2 de la spec de l'etape 4).
 *
 * ⚠️ **Vit ici et pas dans `back/src/draft.ts`, ou il est ne a la tache 5.**
 * C'est une valeur de fil : `Draft` la produit, `Room` la diffuse, et le
 * client la relit pour savoir quelles cartes ranger dans son miroir des
 * inventaires (tache 9). Le client ne peut pas importer `back/` — la
 * constante descend donc au seul endroit que les deux cotes partagent, plutot
 * que d'exister en deux exemplaires qui divergeraient.
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
 * autre. Une sentinelle n'est utilisable que si sa valeur ne designe rien de
 * reel — c'est ce qui rendait `owner = 0` legitime, du temps ou `Card` avait
 * un `owner`.
 */
export const NO_TOKEN = 255;

/** Une identite d'entite, sur le fil : u32. */
export const DEATH_ID_BYTES = 4;

/**
 * `type u8 · element u8 · x i16 · y i16 · bornTick u32 · by u8` = **11 octets**.
 *
 * ⚠️ **Le plan annonce 12 octets pour cette liste de champs ; elle en fait
 * 11.** La spec (§2 et §5.3) ecrit « ~12 octets », un ordre de grandeur, et le
 * plan a durci l'approximation en chiffre exact sans la recompter. L'octet
 * manquant est vraisemblablement le `rayon` que la table du §8 de la spec
 * listait encore : il n'est pas sur le fil (voir `ZoneMessage`), le compte
 * tombe donc a 11. La liste de champs fait foi, pas le total.
 *
 * Aucun message de disparition : la mort d'une zone se derive de `bornTick`.
 */
export const ZONE_BYTES = 11;

/** `type u8 · pair u8 · x i16 · y i16 · tick u32 · synergie u8` = 11 octets. */
export const REACTION_BYTES = 11;

/** `type u8 · tick u32 · level u8`. */
export const LEVEL_UP_BYTES = 6;
/** `type u8 · tick u32 · survivedTicks u32 · level u8 · kills u32`. */
export const RUN_OVER_BYTES = 14;

/**
 * Ouvre une vue sur le buffer en exigeant une taille minimale.
 *
 * C'est le seul endroit ou l'on refuse un buffer court, et il n'existe que pour
 * ca : un decodeur qui lit au-dela de la fin rend des valeurs fantaisistes au
 * lieu de lever, et on passe ensuite des heures a chercher une bogue de gameplay
 * la ou il y a une bogue de cadrage reseau.
 */
function viewOf(buf: ArrayBuffer, minBytes: number): DataView {
  if (buf.byteLength < minBytes) {
    throw new Error(`message tronque : ${buf.byteLength} octets recus, ${minBytes} attendus`);
  }
  return new DataView(buf);
}

/**
 * Arrondit et borne un axe sur l'intervalle d'un octet signe (-127..127) —
 * -128 est exclu pour rester symetrique, comme `moveX`/`moveY` l'ont toujours
 * ete.
 *
 * Exportee (tache 13) : c'est la MEME fonction que le client doit appliquer a
 * sa visee avant de tirer localement, pas seulement avant d'encoder. Sinon le
 * client tire avec son flottant d'origine pendant que le serveur ne voit
 * jamais que la version quantifiee recue par `INPUT` — un ecart systematique
 * d'une fraction de degre, pas transitoire. Meme discipline que
 * `Math.round(p.x)` avant `PlayerHistory.record` cote serveur (tache 9).
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

/** C -> S : une entree, 7 octets (tache 13 : +aimX +aimY). */
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
 * `SNAPSHOT_PLAYER_BYTES` par joueur.
 *
 * `xp` et `synergy` sont des parametres a part, pas des champs de
 * `players[i]` : ce sont ceux de l'**equipe**, communs a tous (§2 de la spec
 * d'orientation, §7 de celle de l'etape 5a), et ils vivent dans l'en-tete
 * plutot que d'etre repetes — et donc potentiellement divergents — dans chaque
 * bloc joueur.
 *
 * `aimX`/`aimY` sont quantifies par `quantizeAxis`, comme dans `encodeInput` :
 * un joueur ne peut de toute facon jamais transmettre plus que cette
 * precision, le serveur n'a donc rien a arrondir de plus en la retransmettant.
 */
export function encodeSnapshot(
  tick: number,
  xp: number,
  synergy: number,
  players: readonly PlayerSnapshot[],
  boss: BossSnapshot | null = null,
): ArrayBuffer {
  const buf = new ArrayBuffer(SNAPSHOT_HEADER_BYTES + players.length * SNAPSHOT_PLAYER_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.SNAPSHOT);
  v.setUint32(1, tick >>> 0, true);
  v.setUint8(5, players.length);
  v.setUint16(6, xp, true);
  v.setUint16(8, synergy, true);
  v.setUint32(10, boss ? boss.id : NO_BOSS_ID, true);
  // ⚠️ **Arrondi ET borne, explicitement.** `Horde.hp` est un flottant ; sans
  // l'arrondi, `setUint32` tronquerait vers zero, et sans la borne il
  // replierait modulo 2^32 au palier 119 — le repli silencieux de l'etape 4.
  v.setUint32(14, boss ? Math.min(BOSS_HP_MAX, Math.max(0, Math.round(boss.hp))) : 0, true);
  let o = SNAPSHOT_HEADER_BYTES;
  for (const p of players) {
    v.setUint8(o, p.id);
    v.setInt16(o + 1, Math.round(p.x), true);
    v.setInt16(o + 3, Math.round(p.y), true);
    v.setUint16(o + 5, p.hp, true);
    v.setInt8(o + 7, quantizeAxis(p.aimX));
    v.setInt8(o + 8, quantizeAxis(p.aimY));
    o += SNAPSHOT_PLAYER_BYTES;
  }
  return buf;
}

export function decodeSnapshot(buf: ArrayBuffer): SnapshotMessage {
  // ⚠️ **DEUX controles, et depuis la tache 4 ils ne se couvrent PLUS.**
  // Celui-ci n'exige que les six octets qu'il faut avoir lus pour connaitre le
  // nombre de joueurs ANNONCE ; le second exige tout le reste. Ecrit avec
  // `SNAPSHOT_HEADER_BYTES` des deux cotes, le premier etait entierement
  // couvert par le second au-dela de six octets — le motif « deux gardes qui
  // se couvrent », quinze fois dans ce depot — et le reduire ne faisait rougir
  // aucun test. Il ne garde donc plus que ce qu'il garde vraiment : un buffer
  // trop court pour porter meme son compte de joueurs.
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
  };
}

/**
 * Empaquette un couple d'elements sur UN octet : le plus petit identifiant
 * dans le quartet de poids fort, le plus grand dans celui de poids faible.
 *
 * ⚠️ **Canonique, donc insensible a l'ordre d'arrivee.** Un choc thermique
 * declenche par un projectile Givre sur une marque Braise et le meme par un
 * projectile Braise sur une marque Givre sont **la meme reaction** (§6.2 : le
 * tableau des declencheurs est symetrique), et ils doivent porter le meme
 * octet — sinon deux clients dessineraient deux flashs differents pour un
 * evenement identique, et une table de reactions indexee par `pair` aurait
 * deux entrees pour une seule ligne du §6.3.
 *
 * ⚠️ **Un quartet, pas un octet par element**, parce que le couple tient alors
 * dans le meme octet que le `pair u8` du §8. Seize elements possibles pour six
 * prevus au §6.3 de l'orientation — `protocol.test.ts` garde la marge en
 * confrontant `ELEMENTS.length` a 16 plutot qu'en la supposant.
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
 * S -> C : une zone au sol vient d'etre posee, 11 octets. Voir `ZoneMessage`
 * pour ce qui n'y est PAS — le rayon, et surtout la mort de la zone.
 */
export function encodeZone(
  element: number,
  x: number,
  y: number,
  bornTick: number,
  by: number,
): ArrayBuffer {
  const buf = new ArrayBuffer(ZONE_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.ZONE);
  v.setUint8(1, element);
  v.setInt16(2, Math.round(x), true);
  v.setInt16(4, Math.round(y), true);
  v.setUint32(6, bornTick >>> 0, true);
  v.setUint8(10, by);
  return buf;
}

export function decodeZone(buf: ArrayBuffer): ZoneMessage {
  const v = viewOf(buf, ZONE_BYTES);
  return {
    type: MSG.ZONE,
    element: v.getUint8(1),
    x: v.getInt16(2, true),
    y: v.getInt16(4, true),
    bornTick: v.getUint32(6, true),
    by: v.getUint8(10),
  };
}

/**
 * S -> C : une reaction a eu lieu, 11 octets.
 *
 * `synergyCharge` est le booleen du §7 — deux joueurs differents a l'origine —
 * deja arbitre par le serveur, et il voyage DANS ce message : les deux
 * arrivent toujours ensemble (§8).
 */
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
 * id u32 x count`. Les deux messages ne different que par leur octet de type,
 * factoriser evite de dupliquer un decalage d'octet dans deux fonctions.
 *
 * Les identites sont triees en ordre croissant a l'encodage : c'est l'ordre
 * canonique d'application (voir `DeathsMessage`), impose ici plutot que
 * laisse a la discretion de chaque appelant.
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
 * nombre d'entites**.
 *
 * C'est la mise en oeuvre du §3.3 : on ne replique pas la horde, on replique
 * son generateur. Repliquer 1 000 ennemis a 30 Hz couterait ~150 ko/s.
 *
 * Le parametre est un type structurel inline plutot que `WaveOrder` de
 * `shared/waves.ts` : le protocole ne doit pas dependre du module de vagues.
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
    default:
      throw new Error(`type de message inconnu : ${type}`);
  }
}

/** Une carte de l'etalage, telle qu'elle transite. Miroir de `Card` de `shared/cards.ts`. */
export interface WireCard {
  nature: number;
  refId: number;
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
 * S -> C : qui a pose sur quoi.
 *
 * Le seul message du draft a cadence soutenue — et le §7.2 point 3 en fait la
 * condition d'existence de la mecanique : « sans cette visibilite, la
 * negociation n'existe pas ».
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
 * S -> C : la resolution.
 *
 * ⚠️ **`deadlineTick` porte la fin du gel, et sans lui le client ne peut pas la
 * deduire.** A l'etape 3 il la calculait — `msg.tick + LEVEL_FREEZE_TICKS - 1`
 * — parce que le gel durait une constante. Ce n'est plus vrai : la fenetre
 * dure jusqu'a ce que tout le monde ait pose son jeton, et en solo elle se
 * ferme au clic.
 *
 * Ce message est emis EXACTEMENT une fois par draft : la resolution est un seul
 * moment. La carte gagnee s'illumine, la carte perdue brule, celle qui la
 * remplace s'illumine a son tour — tout est dans ces `outcomes`.
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

function decodeDraftOpen(buf: ArrayBuffer): DraftOpenMessage {
  const v = viewOf(buf, DRAFT_OPEN_HEADER_BYTES);
  const count = v.getUint8(5);
  viewOf(buf, DRAFT_OPEN_HEADER_BYTES + count * DRAFT_CARD_BYTES);
  const cards: WireCard[] = [];
  let o = DRAFT_OPEN_HEADER_BYTES;
  for (let i = 0; i < count; i++) {
    cards.push({ nature: v.getUint8(o), refId: v.getUint8(o + 1) });
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
