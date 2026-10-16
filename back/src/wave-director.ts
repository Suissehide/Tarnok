import {
  archetypeOf,
  BOSS_ARCHETYPE,
  PORTEUR_ARCHETYPE,
  ROLES,
  type Role,
  STEP2_ARCHETYPES,
} from '@shared/archetypes';
import { MAX_ENTITIES, TICK_HZ, WAVES_PER_PALIER } from '@shared/constants';
import { waveCountScale } from '@shared/paliers';
import { makeRandom } from '@shared/random';
import { FORMATION, type WaveOrder } from '@shared/waves';

/**
 * Decide quand une vague sort, et avec quels parametres. Les vagues sont
 * pilotees par la donnee, pas par du script. Le directeur ne vit que sur le
 * serveur : il decide, les clients obeissent.
 */

const PERIOD_TICKS = TICK_HZ * 6;

/**
 * Bornes de la toute premiere vague — voir `waveCountBounds`. Petites pour
 * laisser au joueur le temps d'obtenir ses premieres armes (premier draft).
 *
 * ⚠️ **Moins d'ennemis, c'est moins d'orbes, et le seuil de niveau ne bouge
 * pas** : un debut trop maigre repousserait la premiere arme au lieu de
 * l'avancer. Gardes : le test « un joueur passif atteint le niveau 2 » de
 * `room.test.ts` et `bench/niveau2.bench.ts`.
 */
const WAVE1_MIN_COUNT = 8;
const WAVE1_MAX_COUNT = 14;

/**
 * Bornes en regime etabli : le joueur doit s'y sentir submerge. C'est ce que
 * les bancs mesurent.
 */
const STEADY_MIN_COUNT = 120;
const STEADY_MAX_COUNT = 320;

/**
 * Nombre de vagues sur lesquelles les bornes interpolent lineairement entre la
 * premiere vague et le regime etabli. A `PERIOD_TICKS` (6 s), 30 vagues font
 * 180 s : une montee sensible, sans que « progressif » se lise comme « jamais ».
 *
 * ⚠️ **L'allonger fait echouer `bench/niveau2.bench.ts`**, et pas par famine
 * d'orbes : la rampe pese sur les vagues qui entourent l'arrivee du premier
 * boss, et quand la pietaille se clairseme, le joueur solo (qui vise la menace
 * la plus proche) vide son chargeur dans le boss pendant que le reste de la
 * vague arrive au contact. Moins de pietaille rend le boss PLUS dangereux au
 * joueur seul. Le rallonger redeviendra possible quand la visee ou le moment
 * d'apparition du boss changeront.
 */
const RAMP_WAVES = 30;

/**
 * ⚠️ **La rampe suit le NIVEAU de l'equipe**, et prend le PLUS AVANCE du
 * niveau et du numero de vague : `RAMP_WAVES` reste un PLANCHER, sans lequel
 * un joueur seul passif n'atteint plus le niveau 2 en 100 s, faute de morts
 * au niveau 1 (`room.test.ts`, « la run est jouable »).
 *
 * Une equipe qui monte vite affronte vite le regime etabli, une equipe qui
 * peine reste sur de petites vagues. Le niveau ne redescend jamais, donc
 * `waveCountBounds` reste monotone. Valeur a confronter au playtest.
 */
export const RAMP_LEVELS = 10;

/**
 * La part de la MONTEE des vagues que voit une equipe de `players` joueurs :
 * 40 % seul, +20 % par joueur, 100 % a quatre (voir `waveCountBounds`). La
 * horde se partage, les joueurs non : un joueur seul tient un secteur, pas
 * quatre.
 *
 * Le besoin d'XP d'un niveau est deja proportionnel au nombre de joueurs
 * (`Room#xpForNextLevel`) : seul, il faut un quart de l'XP de quatre pour 40 %
 * des ennemis — le solo monte donc un peu plus vite, et c'est voulu.
 */
export function playerShare(players: number): number {
  return Math.min(1, (Math.max(1, players) + 1) / 5);
}

/**
 * Les formations tirables.
 *
 * ⚠️ **L'ENCERCLEMENT EST LA REGLE** : les monstres arrivent autour du joueur,
 * pas en pack d'un seul cote (ce qui reduit aussi les collisions).
 * `FORMATION.RING` ne le fait pas : c'est un PETIT anneau autour de l'ancre.
 * Les autres formations restent definies et decodables ; remettre de la
 * variete ne demande que de rallonger cette liste.
 *
 * ⚠️ **Le tirage reste consomme** meme sur une liste d'un seul element : le
 * flux du generateur ne doit pas se decaler, le test de determinisme du
 * directeur le verrouille.
 */
const FORMATION_POOL = [FORMATION.ENCIRCLE];

/** Les archetypes tirables, ranges par role (`ROLES`). */
const POOLS: Readonly<Record<Role, readonly number[]>> = {
  nuee: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'nuee'),
  troupe: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'troupe'),
  brute: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'brute'),
  colosse: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'colosse'),
};

// Le poids des roles (part de vagues lourdes) et la premiere vague ou chacun
// peut sortir vivent dans `ROLES`. Le poids de `brute` est le vrai levier de
// difficulte, regle au banc `bench/kills.bench.ts` ; ouvrir les lourds trop
// tot rend intermittent le test « un joueur passif atteint le niveau 2 » de
// `room.test.ts`.

/**
 * Bornes `[min, max]` du nombre d'entites d'une vague, en fonction du NIVEAU
 * de l'equipe (1-based, voir `RAMP_LEVELS`). Pure, sans tirage : `dueWave`
 * tire `count` dedans.
 *
 * ⚠️ **Monotone et bornee** : `level` croissant ne fait jamais BAISSER les
 * bornes, qui ne depassent jamais `MAX_ENTITIES`. C'est cette forme que le
 * test verrouille, pas les valeurs des constantes, faites pour etre retouchees.
 */
export function waveCountBounds(
  level: number,
  share = 1,
  waveNumber = 1,
): { min: number; max: number } {
  // ⚠️ **La part des joueurs ne pese que sur la MONTEE, jamais sur la premiere
  // vague** : `WAVE1_*` est regle pour le joueur SEUL. La reduire aussi
  // affame le solo (`room.test.ts`, « la run est jouable »).
  const parNiveau = Math.min(1, Math.max(0, (level - 1) / (RAMP_LEVELS - 1)));
  const parVague = Math.min(1, Math.max(0, (waveNumber - 1) / (RAMP_WAVES - 1)));
  const t = share * Math.max(parNiveau, parVague);
  const min = Math.round(WAVE1_MIN_COUNT + t * (STEADY_MIN_COUNT - WAVE1_MIN_COUNT));
  const max = Math.round(WAVE1_MAX_COUNT + t * (STEADY_MAX_COUNT - WAVE1_MAX_COUNT));
  return { min: Math.min(min, MAX_ENTITIES), max: Math.min(max, MAX_ENTITIES) };
}

/** Les roles deja ouverts a la vague `waveNumber` (`ROLES.firstWave`). */
function ouvert(r: Role, waveNumber: number): boolean {
  return waveNumber >= ROLES[r].firstWave && POOLS[r].length > 0;
}

/**
 * Tire un role parmi `roles`, au poids de `ROLES`, parmi ceux deja ouverts ;
 * `troupe` si aucun ne l'est.
 */
function pickRole(rng: () => number, roles: readonly Role[], waveNumber: number): Role {
  const ouverts = roles.filter((r) => ouvert(r, waveNumber));
  const total = ouverts.reduce((n, r) => n + ROLES[r].weight, 0);
  let roll = rng() * total;
  for (const r of ouverts) {
    roll -= ROLES[r].weight;
    if (roll < 0) {
      return r;
    }
  }
  return ouverts[ouverts.length - 1] ?? 'troupe';
}

/** Un archetype du role, au hasard. */
function pickInRole(rng: () => number, role: Role): number {
  const pool = POOLS[role];
  return pool[Math.floor(rng() * pool.length)] ?? 0;
}

/**
 * Le CYCLE des vagues ordinaires d'un palier. Un squelette fixe, un contenu
 * tire : la pression monte, culmine, puis retombe — et le boss vient
 * apres. Chaque vague melange un role PRINCIPAL et une ESCORTE.
 *
 * - `main` : les roles ou tirer le principal (au poids de `ROLES`) ;
 * - `escort` : le premier role OUVERT de la liste, different du principal ;
 * - `share` : la part de l'effectif qui va a l'escorte ;
 * - `size` : multiplie l'effectif de la vague entiere.
 */
interface Slot {
  name: string;
  main: readonly Role[];
  escort: readonly Role[];
  share: number;
  size: number;
}

export const WAVE_CYCLE: readonly Slot[] = [
  { name: 'nuee', main: ['nuee'], escort: ['troupe'], share: 0.2, size: 1 },
  { name: 'troupe', main: ['troupe'], escort: ['brute', 'nuee'], share: 0.25, size: 1 },
  {
    name: 'pic',
    main: ['troupe', 'brute', 'nuee'],
    escort: ['colosse', 'brute', 'troupe'],
    share: 0.2,
    size: 1.3,
  },
  { name: 'repit', main: ['troupe'], escort: [], share: 0, size: 0.5 },
];

/**
 * Nombre d'entites de la vague de boss. **Un, et c'est une regle de
 * conception, pas un reglage** : la vie du boss ne voyage sur le fil que parce
 * qu'il est UN. Dix boss seraient de la pietaille d'elite, a vie serveur seul.
 */
const BOSS_WAVE_COUNT = 1;

/**
 * Le porteur de coffre : demande a la 2e vague (groupe) de chaque palier, boss
 * compris dans le compte des vagues.
 */
export const PORTEUR_WAVE_IN_PALIER = 2;

/**
 * ...mais jamais a moins de 50 vagues (50 x 6 s = 5 min) du precedent.
 *
 * ⚠️ Une equipe qui tue les boss a mesure change de palier toutes les 30 a
 * 90 s : sans ce plancher, « un par palier » deviendrait un porteur par
 * minute. Un palier qui passe sa 2e vague sans porteur n'en aura pas : rien ne
 * se rattrape.
 */
export const PORTEUR_MIN_GAP_WAVES = 50;

/**
 * Distance entre le joueur cible par la vague et l'ancre du porteur. La
 * formation `POINT` le pose a 40 px pres ; pres d'un bord, `formationPositions`
 * le ramene dans la carte, donc PLUS PRES — c'est le « ~ » du design.
 */
export const PORTEUR_SPAWN_DISTANCE = 1500;

export class WaveDirector {
  #nextWaveId = 1;
  readonly #rng: () => number;

  /**
   * Le palier courant, `0` pour le premier — l'argument `k` des formules de
   * `shared/paliers.ts`.
   *
   * ⚠️ **Il n'avance QU'A la mort d'un boss** (`bossDefeated`), jamais a un
   * tick : c'est ce qui rend le rythme elastique.
   */
  #palier = 0;

  /** Vagues ordinaires emises depuis le dernier boss demande. */
  #wavesInPalier = 0;
  /** Vagues (groupes) emises depuis le debut : le numero qui fait la rampe. */
  #waveNumber = 0;

  /**
   * `waveId` du DERNIER boss demande, `null` avant le premier. Pas un verrou :
   * plusieurs boss peuvent vivre a la fois.
   */
  #bossWaveId: number | null = null;

  /** Vagues (groupes) emises depuis le debut du palier ; remis a zero par `bossDefeated`. */
  #wavesSincePalier = 0;
  /** `#waveNumber` du dernier porteur demande. */
  #lastPorteurWave = Number.NEGATIVE_INFINITY;
  /**
   * Vrai entre la demande d'un porteur et `porteurGone` : un porteur en vie
   * bloque le suivant (jamais deux a la fois).
   */
  #porteurEnJeu = false;

  constructor(seed: number) {
    this.#rng = makeRandom(seed);
  }

  /** Le palier courant (`0` pour le premier). Voir `shared/paliers.ts`. */
  get palier(): number {
    return this.#palier;
  }

  /**
   * `waveId` du boss du palier en cours, `null` si aucun n'est attendu.
   *
   * Le salon s'en sert pour reconnaitre, juste apres `due`, que l'ordre qu'il
   * vient de recevoir EST le boss.
   */
  get bossWaveId(): number | null {
    return this.#bossWaveId;
  }

  /**
   * Le boss du palier est mort : le palier suivant commence.
   *
   * ⚠️ **Appele depuis le lot de morts UNIQUE du tick** (`Room.step`), jamais
   * depuis un second chemin de mort : le rejeu client en depend.
   */
  bossDefeated(): void {
    // Pas de verrou : un boss vient tous les `WAVES_PER_PALIER` vagues, qu'un
    // autre vive ou non, et CHAQUE boss abattu fait monter le palier.
    this.#palier++;
    this.#wavesSincePalier = 0;
  }

  /**
   * Le boss demande n'est jamais apparu — la horde etait pleine quand son
   * ordre est tombe (`Horde.spawn` tronque a `capacity`).
   *
   * La demande est rejouee a la prochaine echeance, sans faire avancer le
   * palier.
   */
  bossMissing(): void {
    this.#wavesInPalier = WAVES_PER_PALIER;
  }

  /**
   * Le porteur demande n'est plus en jeu : il est mort, ou son ordre n'a rien
   * fait naitre (horde pleine), ou il a ete retire hors du lot de morts.
   *
   * ⚠️ **La SEULE sortie de `#porteurEnJeu`**, pour tous les cas. Sans elle,
   * plus aucun porteur pour le reste de la run.
   */
  porteurGone(): void {
    this.#porteurEnJeu = false;
  }

  /**
   * Ajoute l'ordre du porteur EN DERNIER a `groupe` s'il est du — boss
   * compris. ⚠️ **Aucun tirage dans `#rng`** : sa graine et sa direction se
   * DERIVENT de la graine du premier ordre, deja tiree. Les ordres ordinaires
   * restent bit-identiques ; seuls les `waveId` qui suivent se decalent.
   * L'ancre voyage en int16 : le client ne derive pas l'angle, il la lit.
   */
  #avecPorteur(groupe: WaveOrder[], tick: number, anchorX: number, anchorY: number): WaveOrder[] {
    const principal = groupe[0];
    if (
      !principal ||
      this.#wavesSincePalier !== PORTEUR_WAVE_IN_PALIER ||
      this.#waveNumber - this.#lastPorteurWave < PORTEUR_MIN_GAP_WAVES ||
      this.#porteurEnJeu
    ) {
      return groupe;
    }
    const seed = (principal.seed ^ 0x5f3a_c0f1) >>> 0;
    const angle = (seed / 0x1_0000_0000) * Math.PI * 2;
    this.#lastPorteurWave = this.#waveNumber;
    this.#porteurEnJeu = true;
    groupe.push({
      waveId: this.#nextWaveId++,
      spawnTick: tick,
      seed,
      archetype: PORTEUR_ARCHETYPE,
      formation: FORMATION.POINT,
      anchorX: Math.round(anchorX + Math.cos(angle) * PORTEUR_SPAWN_DISTANCE),
      anchorY: Math.round(anchorY + Math.sin(angle) * PORTEUR_SPAWN_DISTANCE),
      count: 1,
    });
    return groupe;
  }

  /**
   * Un `waveId` neuf, hors du cycle : les petits d'un diviseur, les morts d'un
   * necromancien. Meme compteur que les vagues, donc jamais deux fois le meme.
   */
  allocWaveId(): number {
    return this.#nextWaveId++;
  }

  /** Le numero de la derniere vague (groupe) emise, `0` avant la premiere. */
  get waveNumber(): number {
    return this.#waveNumber;
  }

  /**
   * Rend l'ordre PRINCIPAL de la vague due a ce tick, ou null. Les tests et les
   * bancs qui ne veulent qu'un ordre par vague l'utilisent ; le salon, lui,
   * prend le groupe entier (`dueWave`).
   */
  due(
    tick: number,
    playerX: readonly number[],
    playerY: readonly number[],
    level = 1,
  ): WaveOrder | null {
    return this.dueWave(tick, playerX, playerY, level)[0] ?? null;
  }

  /**
   * Rend la vague due a ce tick — un GROUPE d'ordres, principal puis escorte,
   * tous au meme tick et a la meme ancre — ou `[]`. `level` : le niveau de
   * l'equipe, qui fait monter la rampe (`waveCountBounds`) ; le nombre de
   * joueurs en fixe la part (`playerShare`).
   *
   * ⚠️ **Chaque ordre garde son `waveId` et voyage seul** : un groupe, ce sont
   * deux `WAVE_ORDER` emis au meme tick. Le fil ne change pas ; les clients
   * font naitre les deux dans l'ordre d'arrivee, comme le serveur.
   */
  dueWave(
    tick: number,
    playerX: readonly number[],
    playerY: readonly number[],
    level = 1,
  ): WaveOrder[] {
    if (tick === 0 || tick % PERIOD_TICKS !== 0 || playerX.length === 0) {
      return [];
    }

    // Ancrage SUR un joueur : la densite se calcule par grappe de joueurs
    // proches, pas globalement.
    const target = Math.floor(this.#rng() * playerX.length);
    const anchorX = Math.round(playerX[target] ?? 0);
    const anchorY = Math.round(playerY[target] ?? 0);

    this.#waveNumber++;
    this.#wavesSincePalier++;
    const waveNumber = this.#waveNumber;
    // ⚠️ **La part ne s'applique qu'a partir du niveau 2** (voir `playerShare`).
    const share = level >= 2 ? playerShare(playerX.length) : 1;
    const { min, max } = waveCountBounds(level, share, waveNumber);
    // ⚠️ **Tire AVANT de savoir si c'est un boss, et toujours** : le flux du
    // generateur ne doit pas dependre de la vitesse a laquelle les boss meurent.
    const tirage = min + this.#rng() * (max - min);
    const formation = (): number =>
      FORMATION_POOL[Math.floor(this.#rng() * FORMATION_POOL.length)] ?? 0;

    if (this.#wavesInPalier >= WAVES_PER_PALIER) {
      // Le boss : un ordre, seul.
      const seed = (this.#rng() * 0xffff_ffff) >>> 0;
      const boss: WaveOrder = {
        waveId: this.#nextWaveId++,
        spawnTick: tick,
        seed,
        archetype: BOSS_ARCHETYPE,
        formation: formation(),
        anchorX,
        anchorY,
        count: BOSS_WAVE_COUNT,
      };
      this.#bossWaveId = boss.waveId;
      this.#wavesInPalier = 0;
      return this.#avecPorteur([boss], tick, anchorX, anchorY);
    }

    const slot = WAVE_CYCLE[this.#wavesInPalier % WAVE_CYCLE.length] ?? WAVE_CYCLE[0];
    this.#wavesInPalier++;
    if (!slot) {
      return [];
    }
    // L'effectif de la vague entiere, a l'echelle du palier et du creneau.
    const total = tirage * waveCountScale(this.#palier) * slot.size;
    const borne = (n: number): number => Math.max(1, Math.min(MAX_ENTITIES, Math.round(n)));

    const mainRole = pickRole(this.#rng, slot.main, waveNumber);
    const escortRole = slot.escort.find((r) => r !== mainRole && ouvert(r, waveNumber));
    const partEscorte = escortRole ? slot.share : 0;

    const ordre = (role: Role, part: number): WaveOrder => {
      const seed = (this.#rng() * 0xffff_ffff) >>> 0;
      const archetype = pickInRole(this.#rng, role);
      return {
        waveId: this.#nextWaveId++,
        spawnTick: tick,
        seed,
        archetype,
        formation: formation(),
        anchorX,
        anchorY,
        // Le role fait la taille : une nuee deborde, un colosse vient presque seul.
        count: borne(total * part * archetypeOf(archetype).countFactor),
      };
    };

    const out = [ordre(mainRole, 1 - partEscorte)];
    if (escortRole) {
      out.push(ordre(escortRole, partEscorte));
    }
    return this.#avecPorteur(out, tick, anchorX, anchorY);
  }
}
