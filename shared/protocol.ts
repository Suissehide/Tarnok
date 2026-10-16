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
  EVENT_START: 28,
  EVENT_STATE: 29,
  EVENT_END: 30,
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
  /**
   * Rayon de ramassage de CE joueur (tache 7 de l'etape 7b) : `ORB_PICKUP_RADIUS`
   * plus ses achats d'aimant. Personnel depuis que la boutique le rend
   * achetable — voir `SNAPSHOT_PLAYER_BYTES`.
   */
  pickupRadius: number;
  /**
   * Reserve de bouclier de CE joueur (etape 13), `0` chez qui ne porte pas
   * Transcendance — voir `SNAPSHOT_PLAYER_BYTES`.
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
  /**
   * L'or NON SECURISE de l'equipe (§5 de la spec de l'etape 6a), sur quatre
   * octets.
   *
   * ⚠️ **Un seul nombre pour l'equipe, dans l'EN-TETE, a cote de `xp` et de
   * `synergy`** — trois grandeurs d'equipe, trois nombres uniques, aucun bloc
   * de joueur ne les porte. Le porter par joueur serait l'erreur que l'etape 3
   * a faite avec l'experience : deux sources de verite pour un seul nombre.
   *
   * ⚠️ **C'est un TOTAL, pas un evenement.** Il est repete a chaque tick parce
   * que c'est l'ENJEU du vote (§6) : un vote dont on ne voit pas l'enjeu n'est
   * pas un vote, et un client qui aurait manque le `PORTAL_RESULT` d'un palier
   * precedent se recale au snapshot suivant sans que rien n'ait a etre
   * rejoue. Quatre octets par snapshot le valent : la meme information portee
   * par evenement demanderait un accuse de reception.
   */
  gold: number;
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
 * `bornTick` et de `ZONE_LIFETIME_TICKS`, des deux cotes — c'est le modele que
 * les orbes ont porte de l'etape 3 a l'etape 6a (leur peremption a disparu a la
 * tache 15), et celui de `ZoneField.expire`.
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
 *
 * ⚠️ **Depuis la tache 5 de l'etape 5b, `kind` n'est plus un simple index
 * d'element** : c'est l'octet empaquete par `packZoneKind` (element dans les
 * bits 0-2, type de champ de reaction dans les bits 3-6). Le decoder avec
 * `zoneElement` / `zoneReaction`, jamais le lire brut — voir leur docbloc.
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

/**
 * S -> C : le boss charge (etape 6a, tache 5 bis).
 *
 * ⚠️ **UN SEUL MESSAGE, A L'ANNONCE, ET PLUS RIEN ENSUITE.** Ce n'est pas un
 * telegraphe cosmetique : pendant toute la charge, **la position du boss est
 * pilotee par cette attaque et non par le champ de flux** (§4 de la spec).
 * C'est donc le deuxieme effet du jeu qui touche le DEPLACEMENT, apres le
 * ralentissement du Givre — et la parade est la meme, celle qui a deja servi
 * trois fois : les TICKS voyagent, la progression se DERIVE. Les deux cotes
 * calculent la meme fraction sur les memes ticks, donc la meme position, pour
 * zero octet apres l'annonce.
 *
 * ⚠️ **La direction est figee au chargement et n'est jamais corrigee.** Un
 * message de suivi ferait suivre le couloir a sa cible : ce serait une taxe,
 * pas une attaque.
 *
 * ⚠️ **La longueur et la largeur SONT sur le fil, contrairement au rayon d'une
 * zone.** `ZoneMessage` documente le choix inverse (« pas de rayon sur le fil,
 * toutes les zones portent `ZONE_RADIUS` »), et il reste bon pour les zones :
 * elles partent par dizaines. Une charge part une fois toutes les ~3,6 s et par
 * boss : quatre octets y achetent un couloir qui pourra differer d'un boss a
 * l'autre (etape 6b, « le pool tournant ») sans changer le protocole. Le
 * desaccord avec la convention des zones est assume et dit ici plutot que
 * cache.
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
  | PingShownMessage
  | EventStartMessage
  | EventStateMessage
  | EventEndMessage;

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
 * ⚠️ **Calque sur `DRAFT_OPEN`, sauf sur un point : LE MONDE NE S'ARRETE
 * PAS.** Le §6 de la spec en fait la difference structurante — *« le draft
 * gele parce qu'un choix de carte n'a pas d'enjeu temporel ; le vote ne gele
 * pas parce que le temps EST son enjeu »*. Ce message n'annonce donc pas un
 * gel, seulement une echeance.
 *
 * ⚠️ **Il ne porte PAS l'or en jeu**, et c'est voulu : l'or est dans le
 * `SNAPSHOT`, trente fois par seconde, parce qu'il BOUGE pendant la fenetre —
 * la horde continue d'avancer, les monstres continuent de laisser des pieces
 * (tache 14). Le figer ici donnerait au client un chiffre perime des le tick
 * suivant.
 *
 * ⚠️ **Il porte le MULTIPLICATEUR, et la version precedente de ce commentaire
 * se trompait deux fois en une phrase (tache 10).** Elle disait que le
 * multiplicateur etait « dans le `SNAPSHOT` » : il n'y a jamais ete —
 * `SNAPSHOT_HEADER_BYTES` porte `xp`, `synergy`, le boss et l'or, rien d'autre.
 * Et elle disait qu'il « bouge pendant la fenetre » : il ne bouge pas. La seule
 * ligne du jeu qui le change est dans `Room#stepPortal`, et elle s'execute
 * APRES le verdict — donc au moment ou la fenetre se ferme, jamais pendant.
 * C'est exactement le profil de `DRAFT_OPEN` : **une valeur constante sur toute
 * la fenetre, donc annoncee une fois plutot que repetee**.
 *
 * ⚠️ **Et le client ne peut PAS le deviner.** Ni en le codant en dur (c'est un
 * reglage, `EXTRACT_MULTIPLIER_STEP`), ni en comptant les portails qu'il a vus
 * s'ouvrir : un client qui se connecte au palier 7 en a vu zero et se
 * tromperait de 1,75. C'est la classe de bug que « annoncer une fois » existe
 * pour eviter, et c'est ce qui rend l'annonce obligatoire ici.
 */
export interface PortalOpenMessage {
  type: typeof MSG.PORTAL_OPEN;
  deadlineTick: number;
  /**
   * Le multiplicateur qui s'applique si l'equipe part MAINTENANT (1 au premier
   * portail). Celui du portail SUIVANT s'en derive par
   * `+ EXTRACT_MULTIPLIER_STEP`, constante partagee — inutile de porter les
   * deux.
   *
   * Reconstruit a partir des centiemes transportes, donc a 0,01 pres : voir
   * `EXTRACT_MULTIPLIER_SCALE`.
   */
  multiplier: number;
}

/**
 * C -> S : le PREMIER message de toute socket de jeu, avant l'attribution du
 * slot.
 *
 * ⚠️ **C'est le seul endroit par lequel le jeton atteint le serveur sur le
 * canal de jeu, et c'est voulu : il ne passe JAMAIS par une URL.** Une URL
 * atterrit dans les journaux du reverse proxy, dans `Referer` et dans
 * l'historique du navigateur — et ce jeton EST le compte (§2.3 de la spec). Le
 * navigateur interdisant les en-tetes personnalises sur un WebSocket, un
 * premier message est la seule voie qui n'expose rien.
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
 * ⚠️ **La visibilite EST la mecanique.** Le §7.2 de l'etape 4 l'a etabli pour
 * les jetons du draft — *« sans cette visibilite, la negociation n'existe
 * pas »* — et le §6 de la spec de l'etape 6a le dit plus fort encore : on ne
 * negocie pas un choix qu'on ne voit pas.
 */
export interface VotesMessage {
  type: typeof MSG.VOTES;
  votes: WireVote[];
}

/**
 * S -> C : le portail a tranche.
 *
 * ⚠️ **`effectTick` est le TICK D'EFFET, et sans lui le client ne peut rien
 * deduire.** C'est la lecon R3 de l'etape 4, payee d'une tache : le
 * `DRAFT_RESULT` de l'epoque laissait le client recalculer la fin du gel
 * — `msg.tick + LEVEL_FREEZE_TICKS - 1` — et ce calcul est devenu faux le jour
 * ou la duree a cesse d'etre une constante. Ici il serait faux tout de suite :
 * le vote se resout a la MAJORITE des qu'elle est acquise, donc n'importe
 * quand entre l'ouverture et l'echeance. Le serveur le dit, le client le lit.
 *
 * ⚠️ **`decision` est un VERDICT, pas un decompte.** Le troisieme
 * enseignement du draft : un champ qui decrit ce que le serveur *compare* n'a
 * pas a voyager — `REACTION` ne porte pas les deux joueurs qu'il a compares,
 * il porte un bit. Les voix « rester » et « partir » sont ce que le serveur
 * compare ; leur comparaison est ce qui voyage. Le detail, lui, est deja
 * passe par `VOTES`, ou il vaut quelque chose (on le voit pendant qu'on
 * negocie) plutot qu'ici, ou il ne vaudrait plus rien.
 *
 * ⚠️ **`decision` ne vaut JAMAIS `NO_VOTE`.** L'absence ne bloque pas : a
 * l'echeance on tranche avec ce qu'on a, et l'egalite continue (§6). Il n'y a
 * donc pas d'issue « personne n'a decide ».
 */
export interface PortalResultMessage {
  type: typeof MSG.PORTAL_RESULT;
  /** Le tick ou la decision prend effet — le client ne peut pas le deduire. */
  effectTick: number;
  /** `VOTE_CHOICE.STAY` ou `VOTE_CHOICE.LEAVE`. Jamais `NO_VOTE`. */
  decision: number;
  /**
   * L'or, **acquis** si l'equipe part, **reporte** si elle reste.
   *
   * ⚠️ **UN seul champ, et son sens se lit dans `decision`.** Deux champs
   * (« acquis » et « reporte ») en laisseraient toujours un a zero : le fil
   * porterait une case vide a chaque vote pour eviter une lecture
   * conditionnelle d'une ligne.
   */
  gold: number;
}

export const WELCOME_BYTES = 10;
/** `type u8 · seq u16 · moveX i8 · moveY i8 · aimX i8 · aimY i8` (tache 13 : 5 -> 7). */
export const INPUT_BYTES = 7;
/**
 * `type u8 · tick u32 · playerCount u8 · xp u16 · synergy u16 · bossId u32 ·
 * bossHp u32 · gold u32` — xp et synergy sont ceux de l'EQUIPE (tache 5 de
 * l'etape 5a : 8 -> 10), le boss vient de la tache 4 de l'etape 6a (10 -> 18),
 * l'or de la tache 7 (18 -> 22).
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
export const SNAPSHOT_HEADER_BYTES = 22;

/**
 * `gold` EST UN u32, ET LA LARGEUR A ETE CALCULEE, PAS DEVINEE — troisieme
 * fois dans ce fichier, meme methode que pour `bossHp` deux paragraphes plus
 * haut et pour le `hp` du joueur a l'etape 4.
 *
 * L'or cumule apres le palier `k` vaut la somme des `palierGold(i)`, i de 0 a
 * k — soit `100 x 1,12^i` arrondi (`shared/paliers.ts`) — et il est MAJORE du
 * multiplicateur d'extraction a la sortie. La colonne « majore » suppose la
 * forme du tableau des constantes du plan (`+ 0,25` par palier reste) ; c'est
 * la tache 9 qui la figera, elle ne change pas le verdict.
 *
 * | Largeur | Deborde a l'or brut | ... et majore | Soit, a ~5 min par palier |
 * | --- | --- | --- | --- |
 * | `u8` (255) | palier **2** | palier **1** | jamais tenable |
 * | `u16` (65 535) | palier **38** | palier **22** | **1,8 h** |
 * | **`u32`** (4 294 967 295) | palier **136** | palier **107** | **8,9 h** |
 *
 * ⚠️ **Le `u16` est refuse pour la raison qui a refuse le `u16` du boss, et
 * au meme palier : 22 est ATTEIGNABLE.** Rien ne borne le palier — le §3 de la
 * spec en fait *« la duree de vie du jeu »* — et une longue soiree y arrive.
 * Un `u16` aurait replie une cagnotte de 67 984 a 2 448 en silence, PILE au
 * moment ou elle vaut le plus cher : celui ou l'equipe decide si elle la
 * risque. Le repli silencieux de l'etape 4, sur le nombre qui porte l'enjeu
 * de toute l'etape.
 *
 * ⚠️ **Et l'or ne se compare pas au boss sur le trafic.** Les deux u32 de
 * l'en-tete coutent ensemble `8 x SNAPSHOT_HZ` octets par seconde et par
 * client, sur un trafic mesure a 1,22 ko/s a l'etape 4 — moins de 1 %.
 */
export const GOLD_MAX = 0xffff_ffff;

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
 * `id u8 · x i16 · y i16 · hp u16 · aimX i8 · aimY i8 · pickupRadius u8 ·
 * shield u8` — pas de xp ici, voir `PlayerSnapshot`. Historique des tailles :
 * tache 13 de l'etape 3 : 6 -> 8 ; tache 8 de l'etape 4 : 8 -> 9 ; tache 7 de
 * l'etape 7b : 9 -> 10 ; tache 5 de l'etape 13 : 10 -> 11.
 *
 * ⚠️ **`hp` est passe de `u8` a `u16` a la tache 8 de l'etape 4**, et ce
 * n'etait pas prevu au plan. Le passif « vitalite » ajoute 20 points de vie
 * maximum par carte : a partir de la huitieme (100 + 8 * 20 = 260), un `u8`
 * repliait silencieusement le joueur a 4 points de vie. Un plafond a 255
 * aurait rendu la carte inerte sans le dire. L'octet supplementaire par joueur
 * et par snapshot coute moins de 1 % du trafic mesure a l'etape 3
 * (1,09 ko/s par joueur).
 *
 * ⚠️ **9 est devenu 10 a l'etape 7b, et c'est le cout AFFICHE de cette
 * etape.** Sept etapes consecutives sans un octet ajoute par tick s'arretent
 * ici, par decision explicite : le rayon de ramassage devient achetable, donc
 * personnel, et `DerivedOrbs#capture` (`front/src/net/client.ts`) ne peut pas
 * predire le ramassage d'un coequipier sans connaitre SON rayon — son propre
 * docbloc dit qu'une capture declenchee sans ramassage reel « mentirait ».
 *
 * La proportion : +4 octets par snapshot a quatre joueurs, soit +0,47 ko/s
 * pour le salon a 30 Hz. L'architecture du §3.3 a economise ~150 ko/s en ne
 * repliquant pas les positions de la horde ; ce surcout en represente 0,3 %.
 *
 * ⚠️ **`u8`, et c'est CALCULE** : la base (`ORB_PICKUP_RADIUS`) vaut 90, le
 * maximum achetable (`maxBonus('pickupRadius')`) vaut 80, donc le maximum
 * atteignable vaut 170 ; le plafond d'un octet non signe est 255, soit **85
 * px de marge** — et non 165 : une marge calculee en oubliant de retrancher
 * le bonus lui-meme serait fausse. `shared/shop.test.ts` assene
 * `ORB_PICKUP_RADIUS + maxBonus('pickupRadius') <= 255` en DERIVANT le
 * maximum du catalogue : c'est ce test qui rougira le jour ou quelqu'un
 * ajoute un palier d'aimant, pas une assertion sur le `Math.min(255, ...)` de
 * l'encodeur — avec un maximum atteignable de 170, cette borne ne peut pas se
 * declencher aujourd'hui.
 *
 * ⚠️ **L'octet est ASSUME, et deux variantes moins cheres ont ete ecartees
 * par ecrit** (§3.4 de la spec) : un `u16` doublerait le cout pour une reserve
 * plafonnee, et reutiliser `hp` (chez un porteur, `maxHp` vaut 1, donc
 * `hp + bouclier` est decodable) marcherait mais serait l'astuce qu'on
 * dechiffre a 3 h du matin en se demandant pourquoi la barre d'un allie ment.
 *
 * ⚠️ **Pas « seulement pour le porteur »** : `encodeSnapshot` construit UN
 * tampon pousse une fois pour tout le salon, donc un champ local demanderait
 * un encodage par client — du CPU par tick contre un octet par joueur.
 *
 * Le cout, comme pour `pickupRadius` ci-dessus : +1 octet par joueur et par
 * snapshot, soit +4 octets a quatre joueurs — **+0,47 ko/s pour le salon a
 * 30 Hz**, le meme chiffre qu'a la tache 7 de l'etape 7b (meme largeur
 * ajoutee, meme calcul).
 */
export const SNAPSHOT_PLAYER_BYTES = 11;
export const WAVE_ORDER_BYTES = 19;

/** En-tete commun a `DEATHS` et `PICKUPS` : type u8, tick u32, count u16. */
export const DEATHS_HEADER_BYTES = 7;
/** `type u8 · deadlineTick u32 · count u8`. */
export const DRAFT_OPEN_HEADER_BYTES = 6;
/**
 * Une carte : `nature u8 · refId u8 · upgrade u8 · rarity u8`.
 *
 * ⚠️ **Quatre octets depuis l'etape 10** : la rarete en ajoute un, dans un
 * message envoye une fois par montee de niveau — jamais par tick.
 */
export const DRAFT_CARD_BYTES = 4;
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

/**
 * `type u8 · deadlineTick u32 · multiplicateur u16` (tache 10 : 5 -> 7).
 *
 * Les deux octets du multiplicateur partent **une fois par palier**, soit une
 * fois toutes les ~5 minutes et par client. Il n'y a pas d'arbitrage de trafic
 * a faire ici : c'est le prix d'un chiffre sans lequel l'ecran du vote ne peut
 * afficher aucun des deux montants qu'il doit montrer.
 */
export const PORTAL_OPEN_BYTES = 7;

/**
 * Facteur de quantification du multiplicateur d'extraction : il voyage en
 * CENTIEMES, dans un `u16`.
 *
 * ⚠️ **Vit ICI, avec le reste du cadrage binaire**, comme `CHARGE_DIR_SCALE`
 * quelques lignes plus bas et pour la meme raison : c'est une propriete du FIL,
 * celle qui decide de la resolution qu'un nombre conserve en traversant.
 * `EXTRACT_MULTIPLIER_STEP` (0,25), lui, est un REGLAGE de jeu et reste dans
 * `shared/constants.ts`.
 *
 * ⚠️ **Des centiemes, et pas un nombre de paliers restes.** L'encodage
 * alternatif — un `u8` « k paliers restes », que le client remultiplierait par
 * `EXTRACT_MULTIPLIER_STEP` — obligerait les deux cotes a refaire le MEME
 * calcul a partir de la meme constante, donc a diverger le jour ou la pente
 * cesse d'etre lineaire (le §10 de la spec en fait une question ouverte :
 * *« trop plat, rester ne se justifie pas ; trop raide, partir tot devient
 * absurde »*). Ici, le serveur dit la VALEUR qu'il applique ; le client ne
 * recalcule rien.
 *
 * ⚠️ **ET LA BORNE A ETE CALCULEE, PAS DEVINEE** — quatrieme fois dans ce
 * fichier, meme methode que pour `bossHp` et pour `gold`. Le multiplicateur
 * vaut `1 + 0,25 k` apres `k` « rester » :
 *
 * | Largeur | Deborde au palier | Soit, a ~5 min par palier |
 * | --- | --- | --- |
 * | `u8` (2,55) | **7** | 35 min — **jamais tenable** |
 * | **`u16` (655,35)** | **2 618** | **218 h** |
 *
 * ⚠️ **Le `u8` est refuse pour la raison qui a refuse les `u16` du boss et de
 * l'or : le palier 7 est ATTEIGNABLE en une demi-heure.** Le `u16`, lui,
 * deborde plus de vingt fois APRES l'or : `extractGold` sature `GOLD_MAX` des
 * le palier 107 (voir `GOLD_MAX`), et le jeu a cesse d'etre jouable bien avant
 * l'un comme l'autre. `encodePortalOpen` borne quand meme explicitement plutot
 * que de laisser `setUint16` replier — un multiplicateur de 655,36 qui se
 * relirait 0,00 ferait dire au client que partir ne rapporte rien, au moment
 * exact ou il rapporte le plus. Un test le dit.
 */
export const EXTRACT_MULTIPLIER_SCALE = 100;

/** Plus grande valeur que le multiplicateur peut porter. Voir `EXTRACT_MULTIPLIER_SCALE`. */
export const EXTRACT_MULTIPLIER_MAX = 0xffff / EXTRACT_MULTIPLIER_SCALE;

/**
 * Longueur du jeton de compte, en octets — 32 octets de hasard
 * cryptographique, soit 43 caracteres en base64url.
 *
 * ⚠️ **Largeur FIXE, pas un prefixe de longueur.** Tout le protocole de ce
 * depot est a largeur fixe ou a compte explicite ; un jeton de longueur
 * variable ajouterait le seul champ du fil dont la taille depend de son
 * contenu, pour rien — un jeton n'a aucune raison de varier.
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
 * `type u8 · effectTick u32 · decision u8 · gold u32`.
 *
 * ⚠️ **Pas de decompte des voix.** Il tiendrait en deux octets et il ne dit
 * rien que `VOTES` n'ait deja dit : ce qui voyage ici, c'est le VERDICT. Voir
 * `PortalResultMessage`.
 */
export const PORTAL_RESULT_BYTES = 10;

/**
 * Les deux faces du vote d'extraction (§6 de la spec de l'etape 6a).
 *
 * ⚠️ **Vit ici, pas dans `back/src/portal.ts` ou la machine du vote naitra
 * (tache 8).** C'est une valeur de fil : le client la produit dans son `VOTE`,
 * le serveur la rediffuse dans `VOTES` et la rend comme verdict dans
 * `PORTAL_RESULT`. Le client ne peut pas importer `back/` — la constante vit
 * donc au seul endroit que les deux cotes partagent, plutot qu'en deux
 * exemplaires qui divergeraient. Meme raisonnement que `OUTCOME`, ecrit
 * quelques lignes plus haut pour le draft.
 *
 * ⚠️ **`STAY` vaut ZERO, et ce n'est pas neutre : c'est la valeur par
 * defaut du jeu.** Le §6 tranche *« majorite ; egalite = on continue »* —
 * rester est ce qui arrive quand rien ne se decide.
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
 * ⚠️ **Ne peut valoir NI 0 NI 1 : les deux sont des votes REELS.** C'est
 * exactement la raison qui a fait choisir `NO_TOKEN = 255` a l'etape 4 — la
 * carte 0 est une carte reelle — et le prendre a 0 ici ferait voter « rester »
 * a tous les silencieux, ce que le §6 confie a la regle d'egalite, pas a une
 * sentinelle. La difference se voit des que quelqu'un vote « partir » : deux
 * abstentions et un depart donneraient une majorite pour rester au lieu d'une
 * majorite pour partir.
 *
 * ⚠️ **Une abstention n'est pas une voix.** Elle circule dans `VOTES` — les
 * autres doivent voir qui n'a pas encore tranche, c'est la matiere de la
 * negociation — mais elle ne se compte pas. `PORTAL_RESULT.decision` ne la
 * porte donc jamais.
 */
export const NO_VOTE = 255;

/** Une identite d'entite, sur le fil : u32. */
export const DEATH_ID_BYTES = 4;

/**
 * `type u8 · kind u8 · x i16 · y i16 · bornTick u32 · by u8` = **11 octets**.
 *
 * ⚠️ **`kind`, pas un simple `element` — perime des la tache 5 de l'etape
 * 5b, corrige a la revue finale.** L'octet empaquete par `packZoneKind`
 * porte l'element (bits 0-2) ET le type de champ de reaction (bits 3-6),
 * voir `ZoneMessage` et `zoneElement`/`zoneReaction` : ce champ documente ici
 * exactement le critere « zero octet de plus » de l'etape, au seul endroit
 * ou son cout sur le fil est compte — la liste ne peut pas se permettre de
 * decrire un octet perime.
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

/**
 * `type u8 · entityId u32 · x i16 · y i16 · dirX i16 · dirY i16 · longueur u16
 * · largeur u16 · windupTick u32 · startTick u32 · endTick u32` = **29
 * octets**.
 *
 * ⚠️ **Trois ticks, et aucun n'est derivable des deux autres sans recopier une
 * constante.** `BOSS_CHARGE_WINDUP_TICKS` et `BOSS_CHARGE_TICKS` sont des
 * REGLAGES que la tache 12 va bouger : les envoyer explicitement rend une
 * charge deja en vol insensible a leur retouche, et evite qu'un client d'une
 * autre version ne derive une fenetre differente de celle que le serveur a
 * reellement jouee.
 *
 * Un seul message par charge, soit ~0,3 message/s et 8 octets/s par client
 * pendant un combat de boss — a comparer aux 1,22 ko/s de trafic total mesures
 * a l'etape 4.
 */
export const BOSS_CHARGE_BYTES = 29;

/**
 * Facteur de quantification des composantes de direction d'une charge.
 *
 * ⚠️ **Vit ICI, avec le reste du cadrage binaire, et pas dans `shared/boss.ts`
 * ou la charge est construite.** C'est une propriete du FIL : c'est elle qui
 * decide de la resolution qu'une direction conserve en traversant. La charge,
 * elle, l'importe pour se quantifier AVANT de partir — le serveur derive sa
 * position depuis exactement les nombres que le client decodera (voir
 * `makeBossCharge`), la meme discipline que le centre STOCKE d'une zone.
 *
 * 10 000 tient dans un `int16` (max 32 767) et laisse 1e-4 de resolution, soit
 * moins de 0,1 px d'ecart sur toute la longueur d'un couloir de 900 px.
 */
export const CHARGE_DIR_SCALE = 10000;

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
  // ⚠️ **Arrondi ET borne, explicitement.** `Horde.hp` est un flottant ; sans
  // l'arrondi, `setUint32` tronquerait vers zero, et sans la borne il
  // replierait modulo 2^32 au palier 119 — le repli silencieux de l'etape 4.
  v.setUint32(14, boss ? Math.min(BOSS_HP_MAX, Math.max(0, Math.round(boss.hp))) : 0, true);
  // Borne pour la meme raison que les PV du boss juste au-dessus : au-dela de
  // `GOLD_MAX`, `setUint32` replierait modulo 2^32 et une cagnotte de quatre
  // milliards se reveillerait a quelques pieces. L'arrondi, lui, couvre le
  // multiplicateur d'extraction (tache 9), seul chemin par lequel l'or peut
  // cesser d'etre entier.
  v.setUint32(18, Math.min(GOLD_MAX, Math.max(0, Math.round(gold))), true);
  let o = SNAPSHOT_HEADER_BYTES;
  for (const p of players) {
    v.setUint8(o, p.id);
    v.setInt16(o + 1, Math.round(p.x), true);
    v.setInt16(o + 3, Math.round(p.y), true);
    // ⚠️ **Borne, pour la meme raison que le boss et l'or plus haut : le
    // repli silencieux de l'etape 4.** `setUint16` applique `p.hp` modulo
    // 2^16 ; sans cette borne, un `hp` negatif (etape 13 : un mort qui
    // recevrait un malus avant le plancher de `Room#grantCard`, ou tout
    // futur chemin qui laisserait `hp` filer sous zero) partirait sur le fil
    // pres de 65536 — un mort affiche a PV quasi plein. La garde reste donc
    // ICI, independante de celle de `room.ts` : elle rattrape n'importe quel
    // chemin, present ou futur, pas seulement celui du jour.
    v.setUint16(o + 5, Math.min(0xffff, Math.max(0, p.hp)), true);
    v.setInt8(o + 7, quantizeAxis(p.aimX));
    v.setInt8(o + 8, quantizeAxis(p.aimY));
    v.setUint8(o + 9, Math.min(255, Math.max(0, Math.round(p.pickupRadius))));
    // Meme borne, meme raison : `SHIELD_POOL` est fixe (60), donc largement
    // sous 255, mais un champ non borne replierait modulo 256 au premier
    // chemin futur qui le laisserait deraper — le repli silencieux de
    // l'etape 4, cote bouclier cette fois.
    v.setUint8(o + 10, Math.min(255, Math.max(0, Math.round(p.shield))));
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
 * Ce qu'une zone porte, dans l'octet que `ZONE` avait deja (etape 5b, tache
 * 5) : un COUPLE, pas une seule valeur.
 *
 * | bits | contenu | 0 signifie |
 * | --- | --- | --- |
 * | 0-2 | l'element dont la zone MARQUE les ennemis | ne marque rien |
 * | 3-6 | le type de champ de REACTION | aucun effet de reaction |
 *
 * ⚠️ **Zero octet de plus** : `ZONE_BYTES` reste 11. Les deux cotes lisent
 * le meme octet et en derivent les deux sens — `zoneElement` et
 * `zoneReaction`.
 *
 * ⚠️ **Ne remplace PAS `ReactionTrigger.element`, ne le mange pas non plus.**
 * Ce champ-ci reste le SECOND element du couple (voir son docbloc dans
 * `back/src/combat.ts`) : c'est lui qui evite que le meme tireur redeclenche
 * indefiniment avec une seule arme. Le type de reaction ajoute une donnee, il
 * n'en retire aucune.
 *
 * ⚠️ **7 bits sur 8 : le bit 7 reste a zero.** Six elements tiennent sur 3
 * bits (0-7), quinze types de reaction sur 4 (0-15). `element` et `reaction`
 * sont masques avant l'empaquetage : un appelant qui passerait une valeur
 * hors bornes se ferait tronquer, jamais lever — meme discipline que
 * `packElementPair`.
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
 * S -> C : une zone au sol vient d'etre posee, 11 octets. Voir `ZoneMessage`
 * pour ce qui n'y est PAS — le rayon, et surtout la mort de la zone.
 *
 * ⚠️ **`kind` est DEJA empaquete par l'appelant** (`packZoneKind`), jamais un
 * element brut recompose ici. Cette fonction ne fait que poser l'octet sur le
 * fil, comme avant la tache 5 — c'est le CONTENU de l'octet qui a change, pas
 * son transport.
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
 * S -> C : le boss charge, 29 octets. Voir `BossChargeMessage` — un seul par
 * charge, et **rien ensuite** : la progression se derive des ticks.
 *
 * ⚠️ **Prend la `BossCharge` DEJA construite, jamais des composantes brutes.**
 * `makeBossCharge` a arrondi l'origine et quantifie la direction ; le serveur
 * derive sa propre position depuis ces nombres-la. Encoder autre chose ici
 * ferait suivre au client un couloir voisin mais different — le defaut exact
 * que le centre STOCKE d'une zone evite depuis l'etape 5a.
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
    case MSG.EVENT_START:
      return decodeEventStart(buf);
    case MSG.EVENT_STATE:
      return decodeEventState(buf);
    case MSG.EVENT_END:
      return decodeEventEnd(buf);
    default:
      throw new Error(`type de message inconnu : ${type}`);
  }
}

/** Une carte de l'etalage, telle qu'elle transite. Miroir de `Card` de `shared/cards.ts`. */
export interface WireCard {
  nature: number;
  refId: number;
  upgrade?: number;
  /** La rarete (`RARITY`, etape 10). Absente : commune. */
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

/**
 * S -> C : le portail s'ouvre, jusqu'a `deadlineTick`.
 *
 * ⚠️ **Aucun gel n'est annonce ici, et c'est tout ce qui separe ce message de
 * `DRAFT_OPEN`** : le monde continue de tourner pendant le vote (§6 de la
 * spec). La vague suivante approche — c'est elle qui met la pression, et un
 * gel la supprimerait.
 */
export function encodePortalOpen(deadlineTick: number, multiplier: number): ArrayBuffer {
  const buf = new ArrayBuffer(PORTAL_OPEN_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PORTAL_OPEN);
  v.setUint32(1, deadlineTick >>> 0, true);
  // Borne et arrondi explicites, comme les PV du boss et l'or dans
  // `encodeSnapshot` : sans la borne, `setUint16` replierait modulo 2^16 et un
  // multiplicateur de 655,36 se relirait 0,00 — « partir ne rapporte rien » au
  // moment ou partir rapporte le plus. Voir `EXTRACT_MULTIPLIER_SCALE`.
  const cents = Math.round(multiplier * EXTRACT_MULTIPLIER_SCALE);
  v.setUint16(5, Math.min(0xffff, Math.max(0, cents)), true);
  return buf;
}

/**
 * C -> S : presente le jeton de compte.
 *
 * ⚠️ **Leve si le jeton ne fait pas exactement `TOKEN_BYTES`.** Sans cette
 * garde, un jeton trop court produirait un message de la BONNE taille complete
 * par des zeros : un jeton valide sur le fil, et faux. L'erreur serait alors un
 * refus d'authentification inexplicable, loin de sa cause.
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

/**
 * S -> C : qui a vote quoi.
 *
 * Le seul message du portail a cadence soutenue, exactement comme
 * `DRAFT_INTENTS` l'etait pour le draft — et pour la meme raison, qui est la
 * condition d'existence de la mecanique : on ne negocie pas un choix qu'on ne
 * voit pas.
 */
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

/**
 * S -> C : le portail a tranche.
 *
 * `effectTick` est le tick d'effet, `decision` le verdict, `gold` l'or acquis
 * si l'equipe part et l'or reporte si elle reste. Voir `PortalResultMessage`
 * pour les trois raisons — une par champ — qui font que c'est exactement ce
 * qu'il faut porter, et rien de plus.
 */
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
 * C -> S : le joueur demande son verbe (etape 8, tache 3), 9 octets.
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
 * S -> C : le salon ANNONCE un verbe accepte (etape 8, tache 3), 12 octets.
 *
 * ⚠️ **L'annonce, jamais l'effet.** Les deux cotes derivent l'effet de ces
 * parametres et de ce tick — le patron de `BOSS_CHARGE`, dont la charge deplace
 * le boss de 2700 px en gardant une derive de 0,000 px (scenario 11c de
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

/**
 * C -> S : le joueur demande son verbe, 9 octets.
 *
 * `type u8 · tick u32 · aimX i16 · aimY i16`
 *
 * ⚠️ **Le joueur ne dit PAS quel verbe** : il n'en a qu'un, celui de sa classe,
 * et c'est le salon qui le lit. Laisser le client nommer son verbe l'autoriserait
 * a demander celui d'une autre classe.
 */
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
 * S -> C : le salon ANNONCE un verbe accepte, 12 octets.
 *
 * `type u8 · tick u32 · playerId u8 · verb u8 · x i16 · y i16 · targetId u8`
 *
 * ⚠️ **L'annonce, jamais l'effet.** Les deux cotes derivent l'effet de ces
 * parametres et de ce tick — le patron de `BOSS_CHARGE`, dont la charge deplace
 * le boss de 2700 px en gardant une derive de 0,000 px (scenario 11c de
 * `shared/horde.replication.test.ts`).
 *
 * ⚠️ **12 octets, pas 13.** L'addition `1 + 4 + 1 + 1 + 2 + 2 + 1` donne 12 :
 * aucun octet de reserve n'a ete garde, par choix (amendement du controleur,
 * tache 3 de l'etape 8) — les deux largeurs etaient acceptables, et celle-ci
 * n'engage aucun bit muet qu'il faudrait documenter puis un jour justifier.
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
 * C -> S : le joueur pose un ping (etape 9), 6 octets.
 *
 * `type u8 · intent u8 · x i16 · y i16`
 *
 * ⚠️ **Un evenement, jamais un etat** : rien n'entre dans `SNAPSHOT`. L'intention
 * n'est PAS validee ici — le decodage rend ce que le fil porte, et c'est le salon
 * qui refuse une intention hors de `PING_INTENTS`.
 */
export interface PingMessage {
  type: typeof MSG.PING;
  intent: number;
  x: number;
  y: number;
}

/** S -> C : le salon annonce un ping accepte, a tous, emetteur compris (etape 9), 7 octets. */
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

/**
 * S -> C : un evenement bonus commence (etape 14, §6.1), `5 + 4n` octets.
 *
 * `type u8 · genre u8 · duree u16 · n u8 · n x (x i16, y i16)`
 *
 * ⚠️ **Une DUREE en ticks vivants, jamais une echeance datee.** Le tick du
 * salon avance pendant le gel, l'evenement non : une echeance absolue serait
 * fausse des le premier etalage. Le client pose la sienne sur `pingClock`, qui
 * dort exactement quand l'evenement dort.
 *
 * Les points : les sceaux, la forge, ou le depart puis l'arrivee du convoi. Le
 * client ne recalcule aucun placement. Aucun tick dans ces trois messages : ils
 * ne touchent pas la simulation du client, ils s'affichent a la reception.
 */
export interface EventStartMessage {
  type: typeof MSG.EVENT_START;
  /** `EVENT_KIND`. */
  kind: number;
  durationTicks: number;
  points: { x: number; y: number }[];
}

/**
 * S -> C : ou en est l'evenement, a 5 Hz et seulement pendant un evenement, 7
 * octets. `type u8 · progression u8 · chariot x i16 · chariot y i16 · pv u8`.
 * Octets DEJA quantifies par le salon : progression `floor(255 x fraction)`,
 * PV `ceil(255 x pv / pvMax)` (0 seulement detruit). Zeros hors convoi : un
 * format fixe vaut mieux que trois.
 */
export interface EventStateMessage {
  type: typeof MSG.EVENT_STATE;
  progress: number;
  cartX: number;
  cartY: number;
  cartHp: number;
}

/** S -> C : l'evenement s'acheve, 2 octets. `outcome` : `EVENT_OUTCOME`. */
export interface EventEndMessage {
  type: typeof MSG.EVENT_END;
  outcome: number;
}

export type EventMessage = EventStartMessage | EventStateMessage | EventEndMessage;

export const EVENT_START_HEADER_BYTES = 5;
export const EVENT_POINT_BYTES = 4;
export const EVENT_STATE_BYTES = 7;
export const EVENT_END_BYTES = 2;

/** Encode l'un des trois messages d'evenement : le salon les met en file tels quels. */
export function encodeEvent(msg: EventMessage): ArrayBuffer {
  if (msg.type === MSG.EVENT_START) {
    const buf = new ArrayBuffer(EVENT_START_HEADER_BYTES + msg.points.length * EVENT_POINT_BYTES);
    const v = new DataView(buf);
    v.setUint8(0, MSG.EVENT_START);
    v.setUint8(1, msg.kind);
    v.setUint16(2, msg.durationTicks, true);
    v.setUint8(4, msg.points.length);
    msg.points.forEach((p, i) => {
      const o = EVENT_START_HEADER_BYTES + i * EVENT_POINT_BYTES;
      v.setInt16(o, Math.round(p.x), true);
      v.setInt16(o + 2, Math.round(p.y), true);
    });
    return buf;
  }
  if (msg.type === MSG.EVENT_STATE) {
    const buf = new ArrayBuffer(EVENT_STATE_BYTES);
    const v = new DataView(buf);
    v.setUint8(0, MSG.EVENT_STATE);
    v.setUint8(1, msg.progress);
    v.setInt16(2, Math.round(msg.cartX), true);
    v.setInt16(4, Math.round(msg.cartY), true);
    v.setUint8(6, msg.cartHp);
    return buf;
  }
  const buf = new ArrayBuffer(EVENT_END_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.EVENT_END);
  v.setUint8(1, msg.outcome);
  return buf;
}

function decodeEventStart(buf: ArrayBuffer): EventStartMessage {
  // L'en-tete d'abord, puis la longueur qu'il ANNONCE : un message tronque au
  // milieu d'un point leve au lieu de rendre des positions fantaisistes.
  const head = viewOf(buf, EVENT_START_HEADER_BYTES);
  const n = head.getUint8(4);
  const v = viewOf(buf, EVENT_START_HEADER_BYTES + n * EVENT_POINT_BYTES);
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const o = EVENT_START_HEADER_BYTES + i * EVENT_POINT_BYTES;
    points.push({ x: v.getInt16(o, true), y: v.getInt16(o + 2, true) });
  }
  return {
    type: MSG.EVENT_START,
    kind: v.getUint8(1),
    durationTicks: v.getUint16(2, true),
    points,
  };
}

function decodeEventState(buf: ArrayBuffer): EventStateMessage {
  const v = viewOf(buf, EVENT_STATE_BYTES);
  return {
    type: MSG.EVENT_STATE,
    progress: v.getUint8(1),
    cartX: v.getInt16(2, true),
    cartY: v.getInt16(4, true),
    cartHp: v.getUint8(6),
  };
}

function decodeEventEnd(buf: ArrayBuffer): EventEndMessage {
  const v = viewOf(buf, EVENT_END_BYTES);
  return { type: MSG.EVENT_END, outcome: v.getUint8(1) };
}
