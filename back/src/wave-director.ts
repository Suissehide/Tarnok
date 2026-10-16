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
 * Decide quand une vague sort, et avec quels parametres.
 *
 * Les vagues sont **pilotees par la donnee, pas par du script** (§9.1 de
 * l'orientation). A l'etape 2, la « donnee » se reduit a des bornes tirees ;
 * l'etape 3 lui donnera de vraies definitions typees.
 *
 * Le directeur ne vit que sur le serveur : c'est lui qui decide, les clients
 * obeissent.
 */

const PERIOD_TICKS = TICK_HZ * 6;

/**
 * Bornes de la toute premiere vague — voir `waveCountBounds`.
 *
 * ⚠️ **Reglage mesure, tache 14.** L'etape 2 partait directement a
 * `MIN_COUNT..MAX_COUNT` (120 a 320), soit ~37 apparitions/s en moyenne des
 * la premiere vague : le banc `back/bench/_probe.ts` (jete, voir le rapport
 * de la tache) mesurait un joueur passif mort en ~20 s, avant meme d'avoir pu
 * observer une deuxieme vague dans de bonnes conditions. Cible : que la
 * premiere vague reste tenable par un tireur solo pendant que la horde met
 * plusieurs secondes a traverser `ANCHOR_RADIUS` et entrer a portee — voir le
 * rapport pour la mesure apres reglage.
 *
 * ⚠️ **Baisse a l'etape 5a (16-28 -> 10-18), decision de l'auteur :** *« on
 * fera moins d'ennemi au debut, le temps d'obtenir des armes. »* La premiere
 * arme arrive au premier draft, donc au premier niveau, donc apres ~10 orbes
 * en solo — et la premiere vague tombe au tick 180 (6 s).
 *
 * ⚠️ **Moins d'ennemis, c'est moins d'orbes, et le seuil de niveau ne bouge
 * pas.** Un debut trop maigre repousserait la premiere arme au lieu de
 * l'avancer — l'inverse exact de l'intention. Le test « un joueur passif
 * atteint le niveau 2 » de `room.test.ts` est la garde ; mesure apres la
 * baisse, la montee reste bien dans son budget de 100 s.
 *
 * ⚠️ **Baisse a la tache 18 de l'etape 6a (10-18 -> 8-14), et LA GARDE A
 * TRANCHE OU S'ARRETER.** *« Baisse encore les vagues »*, dit l'auteur. Le
 * banc `bench/niveau2.bench.ts` (40 graines, solo immobile, budget 100 s) dit
 * jusqu'ou, et il dit non bien plus tot qu'on ne l'aurait cru :
 *
 * | Reglage (avec l'encerclement) | Echecs / 40 |
 * | --- | --- |
 * | 10-18, rampe 30 — l'etat d'avant la tache | **2** (contre 9 sans l'encerclement) |
 * | **8-14, rampe 30 (retenu)** | **4** |
 * | 8-14, rampe 36 | 8 |
 * | 8-14, rampe 45 | 12 |
 * | 6-10, rampe 60 | **24** |
 *
 * ⚠️ **CE N'EST PAS LA FAMINE D'ORBES QUI BLOQUE, c'est le boss** — mesure de
 * controle, faite pour ne pas supposer la cause : le meme 6-10 / rampe 60,
 * boss desactive (`WAVES_PER_PALIER` porte a 1000), tombe a **5 echecs sur
 * 40**. Dix-neuf des vingt-quatre pertes sont donc le boss, et le mecanisme
 * est celui que la doc de `bench/niveau2.bench.ts` decrit deja : le joueur
 * solo vise *la menace la plus proche*, et quand la pietaille se clairseme
 * c'est le boss qui devient cette cible — il encaisse 1 500 PV pendant que le
 * reste de la vague arrive au contact. **Moins de pietaille rend donc le boss
 * PLUS dangereux au joueur seul**, ce qu'aucun plan n'avait prevu.
 *
 * Les cinq echecs restants du controle, eux, sont bien la famine annoncee
 * plus haut : la mediane de montee au niveau 2 passe de 42 s a **61 s** sur un
 * budget de 100 s.
 *
 * `RAMP_WAVES` reste donc a 30 : c'est LUI que la garde refuse, pas
 * `WAVE1_*` — la rampe pese sur les vagues 5 a 10, celles qui accompagnent
 * l'arrivee du boss a 30 s.
 */
const WAVE1_MIN_COUNT = 8;
const WAVE1_MAX_COUNT = 14;

/**
 * Bornes en regime etabli — inchangees depuis l'etape 2 (120 a 320) : c'est le
 * palier « submerge » vise par le §7.4 de l'orientation, pas une valeur remise
 * en cause par cette tache. Ce qui change, c'est le CHEMIN pour y arriver.
 */
const STEADY_MIN_COUNT = 120;
const STEADY_MAX_COUNT = 320;

/**
 * Nombre de vagues sur lesquelles les bornes interpolent lineairement entre la
 * premiere vague et le regime etabli. A `PERIOD_TICKS` (6 s), 30 vagues font
 * 180 s : assez pour laisser une impression de montee en puissance sensible,
 * pas assez pour que « progressif » se lise comme « jamais ».
 *
 * ⚠️ **Monte de 20 a 30 a l'etape 5a**, meme decision d'auteur que `WAVE1_*`.
 * Les deux leviers ne font pas la meme chose : baisser `WAVE1_*` rend les
 * PREMIERES vagues plus petites, allonger la rampe laisse plus de temps avant
 * le regime etabli. Il faut les deux pour que « le temps d'obtenir des armes »
 * couvre plus qu'une minute.
 *
 * `STEADY_*` n'est PAS touche : c'est ce que les bancs mesurent, et le §4.1 de
 * l'orientation y tient.
 *
 * ⚠️ **La tache 18 de l'etape 6a a ESSAYE de l'allonger et la mesure a dit
 * non** — voir le tableau de `WAVE1_MIN_COUNT`. A rampe 45 le banc du niveau 2
 * passe de 4 echecs sur 40 a 12, a rampe 60 a 24, et la cause mesuree n'est pas
 * celle qu'on attendait : c'est le boss, que le joueur solo prend pour cible
 * des que la pietaille se clairseme. La rampe est le levier qui pese sur les
 * vagues 5 a 10, donc exactement sur celles qui entourent son arrivee a 30 s.
 * **Le rallonger redeviendra possible le jour ou le joueur seul ne videra plus
 * son chargeur dans le boss** — c'est-a-dire quand la visee cessera d'etre
 * « la menace la plus proche » ou quand le boss cessera d'apparaitre au
 * quatrieme tour d'horloge.
 */
const RAMP_WAVES = 30;

/**
 * ⚠️ **Depuis la retouche de difficulte d'apres l'etape 8, la rampe suit le
 * NIVEAU de l'equipe, plus le numero de vague** — demande de l'auteur : *« en
 * solo, la difficulte est tres elevee »*. `RAMP_WAVES` reste un PLANCHER :
 * sans lui, la rampe ne demarre jamais — un joueur seul passif n'atteint plus
 * le niveau 2 en 100 s, faute d'assez de morts au niveau 1 (mesure,
 * `room.test.ts`, « la run est jouable »). La rampe prend donc le PLUS AVANCE
 * des deux : le temps, ou le niveau.
 *
 * Une equipe qui monte vite affronte vite le regime etabli, une equipe qui
 * peine reste sur de petites vagues : la difficulte devient elastique, comme
 * le palier l'est deja a la mort du boss. Le niveau ne redescend jamais, donc
 * la monotonie de `waveCountBounds` tient toujours.
 *
 * Reglage de depart, a confronter au playtest : 10 niveaux de rampe.
 */
export const RAMP_LEVELS = 10;

/**
 * La part de la MONTEE des vagues que voit une equipe de `players` joueurs :
 * 40 % seul, +20 % par joueur, 100 % a quatre (voir `waveCountBounds`). La horde se partage, les joueurs non : un
 * joueur seul tient un secteur, pas quatre.
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
 * ⚠️ **L'ENCERCLEMENT EST LA REGLE, pas un cas particulier** (tache 18 de
 * l'etape 6a) : *« fais apparaitre les monstres autour du joueur plutot qu'en
 * pack »*. C'etait deja l'intention de l'auteur a l'etape 3 — *« les monstres
 * arriveront en cercle vers le joueur, donc il y aura moins de collision »* —
 * et ca n'avait jamais ete fait.
 *
 * Jusqu'ici le directeur posait l'ancre a 1800 px du joueur dans UNE direction
 * tiree, et les quatre formations (`SCATTER`, `RING`, `COLUMN`, `CLUSTER`)
 * arrangeaient la vague autour de ce point : une vague etait un **pack qui
 * arrive d'un cote**. `FORMATION.RING` ne corrigeait rien — c'est un PETIT
 * anneau autour de l'ancre (`RING_RADIUS` = 700), pas un encerclement du
 * joueur.
 *
 * Le changement se fait dans le POOL, pas par un `if` dans `due` : le tirage de
 * formation reste ce qu'il est, et remettre une variete de formations un jour
 * ne demandera que de rallonger cette liste. Les quatre autres formations
 * restent definies et decodables — l'ordre de vague porte un numero de
 * formation, et rien n'oblige un pool a les utiliser toutes.
 *
 * ⚠️ **Le tirage reste consomme** meme sur une liste d'un seul element : le
 * flux du generateur ne doit pas se decaler, c'est le test de determinisme du
 * directeur qui le verrouille.
 */
const FORMATION_POOL = [FORMATION.ENCIRCLE];

/**
 * Les archetypes tirables, separes par reserve de PV (etape 5a).
 *
 * ⚠️ **C'est le levier de difficulte de l'etape 5a, et il vit ICI.** Le §3.3
 * de la spec engage l'issue d'avance : si le rythme de mise a mort chute de
 * plus de 20 %, *« on reequilibre la proportion de lourds dans les vagues,
 * pas les PV, parce que c'est le generateur qui porte la difficulte »*.
 */
/** Les archetypes tirables, ranges par role (`ROLES`). */
const POOLS: Readonly<Record<Role, readonly number[]>> = {
  nuee: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'nuee'),
  troupe: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'troupe'),
  brute: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'brute'),
  colosse: STEP2_ARCHETYPES.filter((id) => archetypeOf(id).role === 'colosse'),
};

/**
 * Part des vagues faites de pietaille lourde.
 *
 * ⚠️ **Reglage MESURE, porte du §3.3 — pas une valeur d'intuition.** Le §12 de
 * la spec le dit : *« la proportion de pietaille lourde dans les vagues est le
 * vrai levier de difficulte de cette etape, et elle n'a pas de valeur de
 * depart defendable avant la mesure »*. La voici, au banc
 * `bench/kills.bench.ts` (4 joueurs, 60 s, 12 graines) :
 *
 * | Part de vagues lourdes | Morts/s | Ecart |
 * | --- | --- | --- |
 * | 0 (toute la pietaille legere) | 6,96 | reference — le rythme de l'etape 3 |
 * | 0,08 | 6,77 | -2,7 % |
 * | **0,20 (retenue)** | **6,07** | **-12,8 %** |
 * | 0,25 (= tirage uniforme sur les quatre archetypes) | 5,65 | -18,8 % |
 *
 * 0,25 tient encore dans la bande de ±20 % de la spec, mais a 1,2 point de la
 * borne : trop pres pour une mesure a quelques pour cent de bruit. 0,20 garde
 * une marge, et une vague sur cinq faite de lourds suffit largement a ce que
 * le §3.3 demande — des ennemis qui vivent assez longtemps pour porter une
 * marque elementaire.
 *
 * Une vague entiere est lourde ou legere : l'archetype est un champ de
 * `WaveOrder`, un seul pour toute la vague (§3.1 de l'etape 2). Cette part
 * est donc une part de VAGUES, pas d'entites — a nombre d'entites egal en
 * moyenne, les deux coincident.
 */
// ⚠️ Remplace par le poids du role `brute` (`ROLES`) : 0,2 sur les trois
// premiers roles, la part mesuree ci-dessus.

/**
 * Premiere vague qui PEUT etre lourde. Avant elle, la part de lourds vaut zero.
 *
 * ⚠️ **Trouve par la mesure, pas prevu par le plan.** Avec des vagues lourdes
 * des la premiere, un joueur solo IMMOBILE perdait sa run avant le niveau 2
 * dans 3 essais sur 20 (1 sur 20 des une part de 0,08) : quatre coups de dague
 * par ennemi, la horde s'accumule plus vite qu'elle ne tombe, et le test
 * « un joueur passif atteint le niveau 2 » de `room.test.ts` devenait
 * intermittent a 15 %. *Un test intermittent est pire qu'un test absent : on
 * finit par l'ignorer.*
 *
 * A partir de la vague 6 (36 s), 40 essais sur 40 atteignent le niveau 2,
 * mediane 41,3 s et maximum 50,1 s — contre 36,8 / 44,5 avant cette etape,
 * pour un budget de test de 100 s.
 *
 * C'est la meme intention que `WAVE1_*` et `RAMP_WAVES` : *« moins d'ennemi au
 * debut, le temps d'obtenir des armes »*. Une pietaille lourde est un probleme
 * d'arme, pas un probleme de nombre — la dague seule met treize secondes a
 * nettoyer une vague lourde.
 */
// ⚠️ Remplace par `ROLES.brute.firstWave` (6).

/**
 * Bornes `[min, max]` du nombre d'entites d'une vague, en fonction du NIVEAU
 * de l'equipe (1-based, voir `RAMP_LEVELS`) — pure, sans tirage, pour rester testable independamment
 * du hasard : `WaveDirector.due` s'en sert ensuite pour tirer `count` dedans.
 *
 * ⚠️ **Monotone et bornee, pas une formule figee.** `level` croissant ne
 * peut jamais faire BAISSER les bornes, et elles ne depassent jamais
 * `MAX_ENTITIES` (le plafond dur du salon, §3 de la spec) — c'est cette forme
 * que le test verrouille, pas les valeurs de `WAVE1_*` / `STEADY_*` /
 * `RAMP_WAVES`, qui resteront a retoucher au fil des sessions de jeu.
 */
export function waveCountBounds(
  level: number,
  share = 1,
  waveNumber = 1,
): { min: number; max: number } {
  // ⚠️ **La part des joueurs ne pese que sur la MONTEE, jamais sur la premiere
  // vague** : `WAVE1_*` a ete regle au banc pour le joueur SEUL. La reduire
  // aussi affame le solo — mesure : un joueur passif n'atteint plus le
  // niveau 2 en 100 s (`room.test.ts`, « la run est jouable »).
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
 * Le CYCLE des vagues ordinaires d'un palier (retour de playtest : *« des
 * vagues aleatoires ou un peu de regularite ? »*). Un squelette fixe, un
 * contenu tire : la pression monte, culmine, puis retombe — et le boss vient
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
 * conception, pas un reglage** : le §1.1 de la spec de l'etape 6a n'autorise
 * la vie du boss a voyager que parce qu'il est UN. *« Si un jour un palier
 * fait apparaitre dix boss, ce n'est plus un boss, c'est de la pietaille
 * d'elite — et sa vie redevient serveur seul. »*
 */
const BOSS_WAVE_COUNT = 1;

/**
 * Le porteur de coffre (etape 11, §2 de la spec) : demande a la 2e vague
 * (groupe) de chaque palier, boss compris dans le compte des vagues.
 */
export const PORTEUR_WAVE_IN_PALIER = 2;

/**
 * ...mais jamais a moins de 50 vagues (50 x 6 s = 5 min) du precedent.
 *
 * ⚠️ **« Un par palier » ne voulait pas dire « toutes les cinq minutes ».**
 * Un boss sort toutes les `WAVES_PER_PALIER` vagues qu'un autre vive ou non,
 * et CHAQUE boss abattu fait monter le palier : une equipe qui les tue a
 * mesure change de palier toutes les 30 a 90 s. Un palier qui passe sa 2e
 * vague sans porteur (plancher pas atteint, porteur precedent vivant) n'en
 * aura pas : rien ne se rattrape.
 */
export const PORTEUR_MIN_GAP_WAVES = 50;

/**
 * Distance entre le joueur cible par la vague et l'ancre du porteur. La
 * formation `POINT` le pose a 40 px pres ; pres d'un bord, `formationPositions`
 * le ramene dans la carte, donc PLUS PRES — c'est le « ~ » du design.
 */
export const PORTEUR_SPAWN_DISTANCE = 1500;

/**
 * Les evenements bonus (etape 14, §2.1) : marques a la 3e vague (groupe) d'un
 * palier, boss compris dans le compte — le porteur vient a la 2e.
 */
export const EVENT_WAVE_IN_PALIER = 3;

/** ...jamais a moins de 40 vagues (40 x 6 s = 4 min) du precedent. */
export const EVENT_MIN_GAP_WAVES = 40;

/**
 * ...et pas avant la vague qui tombe, au plus tot, a 2 min de jeu (decision
 * de Leo). Une vague n tombe au plus tot au tick `n x PERIOD_TICKS` ; un gel
 * retarde les vagues, jamais ne les avance. ⚠️ **Ecrit en formule** : si la
 * cadence des vagues change, le seuil suit. C'est un MINIMUM : le premier
 * evenement est a la premiere 3e vague de palier a partir de celle-ci.
 */
export const EVENT_FIRST_WAVE = Math.ceil((120 * TICK_HZ) / PERIOD_TICKS);

export class WaveDirector {
  #nextWaveId = 1;
  readonly #rng: () => number;

  /**
   * Le palier courant, `0` pour le premier — l'argument `k` des formules de
   * `shared/paliers.ts`.
   *
   * ⚠️ **Il n'avance QU'A la mort du boss** (`bossDefeated`), jamais a un
   * tick : c'est ce qui rend le rythme elastique (§2 de la spec). Une equipe
   * qui peine reste plus longtemps au palier 3, une equipe qui domine avance.
   */
  #palier = 0;

  /** Vagues ordinaires emises depuis le dernier boss demande. */
  #wavesInPalier = 0;
  /** Vagues (groupes) emises depuis le debut : le numero qui fait la rampe. */
  #waveNumber = 0;

  /**
   * `waveId` du DERNIER boss demande, `null` avant le premier. Ce n'est plus un
   * verrou : plusieurs boss peuvent vivre a la fois.
   */
  #bossWaveId: number | null = null;

  /** Vagues (groupes) emises depuis le debut du palier ; remis a zero par `bossDefeated`. */
  #wavesSincePalier = 0;
  /** `#waveNumber` du dernier porteur demande. */
  #lastPorteurWave = Number.NEGATIVE_INFINITY;
  /**
   * Vrai entre la demande d'un porteur et `porteurGone` : un porteur en vie
   * bloque le suivant (§6 de la spec, pas deux a la fois).
   */
  #porteurEnJeu = false;

  /** `#waveNumber` du dernier evenement marque. */
  #lastEventWave = Number.NEGATIVE_INFINITY;
  /**
   * La graine de l'evenement du a la derniere vague, lue UNE fois par le
   * salon (`takeEventSeed`). ⚠️ **Pas de `#evenementEnJeu`, contrairement au
   * porteur** : un evenement dure au plus `EVENT_DURATION_TICKS` ticks
   * vivants (11 vagues au plus), loin des 40 du plancher — un second garde
   * serait de ceux qu'aucun test ne tient.
   */
  #eventSeed: number | null = null;

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
   * vient de recevoir EST le boss — plutot que de faire rendre a `due` un
   * couple `{ ordre, boss }` qui changerait sa signature pour tous ses
   * appelants et tous ses tests.
   */
  get bossWaveId(): number | null {
    return this.#bossWaveId;
  }

  /**
   * Le boss du palier est mort : le palier suivant commence.
   *
   * ⚠️ **Appele depuis le lot de morts UNIQUE du tick** (`Room.step`), jamais
   * depuis un second chemin de mort a lui : le rejeu de l'etape 3 en depend, et
   * l'etape 5a a deja fusionne les morts par brulure et par reaction dans ce
   * meme lot.
   */
  bossDefeated(): void {
    // ⚠️ **Plus de verrou** (retour de playtest : *« on peut avoir plusieurs
    // boss en meme temps »*) : un boss vient tous les `WAVES_PER_PALIER`
    // vagues, qu'un autre soit encore en vie ou non, et CHAQUE boss abattu
    // fait monter le palier.
    this.#palier++;
    this.#wavesSincePalier = 0;
  }

  /**
   * Le boss demande n'est jamais apparu — la horde etait pleine quand son
   * ordre est tombe (`Horde.spawn` tronque a `capacity`).
   *
   * ⚠️ **Sans ce chemin, le palier se verrouillerait POUR TOUJOURS** : le
   * verrou `#bossWaveId` interdit une seconde demande, et le boss qu'il
   * designe n'existe pas, donc il ne mourra jamais. Ce n'est pas une garde
   * redondante avec `bossDefeated` — les deux ne peuvent pas se produire pour
   * le meme ordre, et celle-ci ne fait PAS avancer le palier : la demande est
   * simplement rejouee a la prochaine echeance.
   */
  bossMissing(): void {
    // La demande est rejouee a la prochaine echeance.
    this.#wavesInPalier = WAVES_PER_PALIER;
  }

  /**
   * Le porteur demande n'est plus en jeu : il est mort, ou son ordre n'a rien
   * fait naitre (horde pleine), ou il a ete retire hors du lot de morts.
   *
   * ⚠️ **La SEULE sortie de `#porteurEnJeu`**, sur le modele de `bossMissing` :
   * une methode pour tous les cas, le directeur n'a pas a savoir lequel. Sans
   * elle, plus aucun porteur pour le reste de la run.
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
   * Marque un evenement si la vague qui sort le doit. ⚠️ **Aucun tirage dans
   * `#rng`, et pas meme un `waveId`** : un evenement n'est pas un ordre de
   * vague, et sa graine se DERIVE de celle de l'ordre principal, deja tiree,
   * par un autre masque que celui du porteur. Le lieu, le genre et l'etat
   * vivent dans le salon, qui seul connait les joueurs vivants et les murs.
   */
  #marquerEvenement(principal: WaveOrder | undefined): void {
    if (
      !principal ||
      this.#waveNumber < EVENT_FIRST_WAVE ||
      this.#wavesSincePalier !== EVENT_WAVE_IN_PALIER ||
      this.#waveNumber - this.#lastEventWave < EVENT_MIN_GAP_WAVES
    ) {
      return;
    }
    this.#lastEventWave = this.#waveNumber;
    this.#eventSeed = (principal.seed ^ 0x2c9e_7d43) >>> 0;
  }

  /** La graine de l'evenement du a cette vague, ou `null` ; la lit et l'oublie. */
  takeEventSeed(): number | null {
    const s = this.#eventSeed;
    this.#eventSeed = null;
    return s;
  }

  /** Le numero de la derniere vague (groupe) emise, `0` avant la premiere. */
  /**
   * Un `waveId` neuf, hors du cycle : les petits d'un diviseur, les morts d'un
   * necromancien. Meme compteur que les vagues, donc jamais deux fois le meme.
   */
  allocWaveId(): number {
    return this.#nextWaveId++;
  }

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

    // Ancrage SUR un joueur : le §8 de l'orientation veut que la densite se
    // calcule par grappe de joueurs proches, pas globalement.
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
      this.#marquerEvenement(boss);
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
    this.#marquerEvenement(out[0]);
    return this.#avecPorteur(out, tick, anchorX, anchorY);
  }
}
