import { archetypeOf, BOSS_ARCHETYPE, HEAVY_HP, STEP2_ARCHETYPES } from '@shared/archetypes';
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
const HEAVY_POOL = STEP2_ARCHETYPES.filter((id) => archetypeOf(id).hp === HEAVY_HP);
const LIGHT_POOL = STEP2_ARCHETYPES.filter((id) => archetypeOf(id).hp !== HEAVY_HP);

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
const HEAVY_WAVE_SHARE = 0.2;

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
const HEAVY_FIRST_WAVE = 6;

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

/**
 * Tire l'archetype d'une vague : lourde avec la probabilite
 * `HEAVY_WAVE_SHARE`, legere sinon.
 *
 * Deux tirages plutot qu'un, toujours dans le meme ordre : le directeur reste
 * une fonction pure de sa graine, ce que le test de determinisme verifie.
 */
function pickArchetype(rng: () => number, waveNumber: number): number {
  const lourde =
    rng() < HEAVY_WAVE_SHARE && HEAVY_POOL.length > 0 && waveNumber >= HEAVY_FIRST_WAVE;
  const pool = lourde ? HEAVY_POOL : LIGHT_POOL;
  return pool[Math.floor(rng() * pool.length)] ?? 0;
}

/**
 * Nombre d'entites de la vague de boss. **Un, et c'est une regle de
 * conception, pas un reglage** : le §1.1 de la spec de l'etape 6a n'autorise
 * la vie du boss a voyager que parce qu'il est UN. *« Si un jour un palier
 * fait apparaitre dix boss, ce n'est plus un boss, c'est de la pietaille
 * d'elite — et sa vie redevient serveur seul. »*
 */
const BOSS_WAVE_COUNT = 1;

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

  /**
   * Vagues ordinaires emises depuis le debut du palier courant. Remis a zero
   * a la mort du boss, pas a son apparition — les vagues continuent de tomber
   * pendant le combat de boss et elles comptent, mais elles ne peuvent pas
   * declencher un second boss puisque `#bossWaveId` est deja pris.
   */
  #wavesInPalier = 0;

  /**
   * `waveId` du boss en cours, `null` quand aucun boss n'est attendu.
   *
   * ⚠️ **C'est le VERROU du palier.** Tant qu'il n'est pas `null`, le
   * directeur n'en demandera pas un second, quel que soit le nombre de vagues
   * ordinaires tombees entre-temps.
   */
  #bossWaveId: number | null = null;

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
    if (this.#bossWaveId === null) {
      return;
    }
    this.#bossWaveId = null;
    this.#wavesInPalier = 0;
    this.#palier++;
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
    this.#bossWaveId = null;
  }

  /**
   * Rend un ordre si une vague est due a ce tick, sinon null. `level` : le
   * niveau de l'equipe, qui fait monter la rampe (`waveCountBounds`) ; le
   * nombre de joueurs en fixe la part (`playerShare`).
   */
  due(
    tick: number,
    playerX: readonly number[],
    playerY: readonly number[],
    level = 1,
  ): WaveOrder | null {
    if (tick === 0 || tick % PERIOD_TICKS !== 0 || playerX.length === 0) {
      return null;
    }

    // Ancrage SUR un joueur : le §8 de l'orientation veut que la densite se
    // calcule par grappe de joueurs proches, pas globalement.
    //
    // ⚠️ **L'ancre EST la position du joueur depuis la tache 18**, et non plus
    // un point pose a `ANCHOR_RADIUS` dans une direction tiree. C'est ce qui
    // fait de la vague un encerclement : `FORMATION.ENCIRCLE` repartit les
    // entites sur un cercle de rayon `ENCIRCLE_RADIUS` (1800 px, la valeur de
    // l'ancien `ANCHOR_RADIUS`) autour de l'ancre. La distance de naissance n'a
    // donc pas change ; la DIRECTION, elle, n'est plus unique.
    //
    // Deux tirages ont disparu avec l'ancien ancrage — l'angle et le rayon.
    // Aucun determinisme n'en souffre : le flux du generateur n'a pas a etre
    // le meme qu'a la version precedente du directeur, seulement le meme d'une
    // instance a l'autre a graine egale. Ce que le flux ne doit pas faire,
    // c'est varier D'UN APPEL A L'AUTRE selon l'etat de la partie (boss ou
    // non) — voir `tirage` et `pickArchetype` plus bas.
    const target = Math.floor(this.#rng() * playerX.length);

    const waveNumber = this.#nextWaveId;
    // ⚠️ **La part ne s'applique qu'a partir du niveau 2.** Le niveau 1 est la
    // zone reglee au banc pour le joueur SEUL (`WAVE1_*`, `RAMP_WAVES`) : y
    // reduire la horde l'affame — moins de morts, moins d'orbes, et un joueur
    // passif n'atteint plus le niveau 2 en 100 s (`room.test.ts`, mesure).
    const share = level >= 2 ? playerShare(playerX.length) : 1;
    const { min, max } = waveCountBounds(level, share, waveNumber);

    // ⚠️ **Tire AVANT de savoir si c'est un boss, et toujours.** La vague de
    // boss ignore ce tirage (elle vaut `BOSS_WAVE_COUNT`), mais s'en abstenir
    // decalerait le flux du generateur d'un cran a chaque palier : deux
    // directeurs de meme graine ne produiraient plus la meme suite selon la
    // vitesse a laquelle leurs boss meurent. Le determinisme du directeur est
    // ce que verifie le test « est deterministe pour une meme graine ».
    const tirage = min + this.#rng() * (max - min);

    // Le boss est du : `WAVES_PER_PALIER` vagues ordinaires sont tombees et
    // aucun boss n'est encore en jeu.
    const boss = this.#wavesInPalier >= WAVES_PER_PALIER && this.#bossWaveId === null;

    // ⚠️ **Ces deux lignes sont sorties du litteral, et l'ORDRE dans lequel
    // elles consomment le generateur est le meme qu'avant** : la graine, puis
    // les deux tirages de `pickArchetype`, puis la formation. Les sortir du
    // litteral etait necessaire pour que la vague de boss puisse IGNORER le
    // tirage d'archetype sans s'en abstenir — s'en abstenir decalerait le flux
    // d'un cran a chaque palier, et deux directeurs de meme graine ne
    // produiraient plus la meme suite selon la vitesse a laquelle leurs boss
    // meurent. Meme raison que `tirage` ci-dessus.
    const seed = (this.#rng() * 0xffff_ffff) >>> 0;
    const tirageArchetype = pickArchetype(this.#rng, waveNumber);

    const order: WaveOrder = {
      waveId: this.#nextWaveId++,
      spawnTick: tick,
      seed,
      // ⚠️ **Le boss est un ARCHETYPE, pas un type d'entite.** `Horde` ne gagne
      // aucun tableau, `count` vaut 1, et tout le reste — identite
      // arithmetique, champ de flux, separation, collision, orbes, marques
      // elementaires — marche parce que rien n'a ete ecrit pour lui. Ses PV et
      // sa taille sortent de `shared/archetypes.ts`, et l'echelle du palier lui
      // est appliquee par `Room` comme a n'importe qui.
      archetype: boss ? BOSS_ARCHETYPE : tirageArchetype,
      formation: FORMATION_POOL[Math.floor(this.#rng() * FORMATION_POOL.length)] ?? 0,
      anchorX: Math.round(playerX[target] ?? 0),
      anchorY: Math.round(playerY[target] ?? 0),
      // ⚠️ **L'echelle du palier s'applique ICI, cote SERVEUR, avant que
      // l'ordre ne parte** : `count` voyage dans les 19 octets, donc le client
      // recoit un compte deja resolu et n'a rien a savoir du palier pour faire
      // apparaitre la meme vague. C'est la voie « les valeurs voyagent deja
      // resolues » du plan, appliquee a l'effectif.
      count: boss ? BOSS_WAVE_COUNT : Math.round(tirage * waveCountScale(this.#palier)),
    };

    if (boss) {
      this.#bossWaveId = order.waveId;
    } else {
      // ⚠️ **Les vagues ordinaires continuent de compter PENDANT le combat de
      // boss, et c'est sans effet** : le verrou `#bossWaveId` interdit deja une
      // seconde demande. Ce compteur est remis a zero par `bossDefeated`, donc
      // le palier suivant repart bien de zero vague.
      this.#wavesInPalier++;
    }

    return order;
  }
}
