# Étape 4 — le draft : plan d'implémentation

> ⚠️ **Ce plan décrit un modèle de cartes qui n'existe plus.** Il a été exécuté intégralement, puis
> l'auteur a joué et a corrigé le modèle : plus de niveaux d'arme, plus d'évolutions, plus
> d'`owner`, plus d'exclusivité d'équipe, plus de repioche. Les armes s'empilent comme les passifs,
> toute carte est ouverte à tous, et la résolution est un seul moment.
>
> **La spec, elle, est à jour** — voir son §9.1, qui liste ce qui est tombé et ce qui l'a remplacé.
> Ce plan est conservé tel quel comme trace de l'exécution : les tâches 1 à 5 et 10 y décrivent un
> modèle que le code ne suit plus. Ne pas s'en servir comme référence.

> **Pour un agent exécutant :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans`.
> Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** à chaque montée de niveau, l'équipe drafte sur un étalage commun, les conflits se
résolvent au hasard avec une révélation lisible, et la carte prise a un effet réel.

**Architecture :** le serveur possède tout — le tirage, les jetons, la résolution. Le client
affiche. Le draft ne participe pas au contrat de réplication : rien n'est dérivé, rien n'est
rejoué. Seule l'échéance est datée par tick, pour que les clients s'accordent sur la fermeture.

**Stack :** TypeScript, Vitest, PixiJS v8.

**Spec :** [`../specs/2026-08-26-etape-4-draft.md`](../specs/2026-08-26-etape-4-draft.md) — à lire
avant de commencer. Le plan argumente depuis la spec ; les deux voyagent ensemble.

## Contraintes globales

- **Code et identifiants en anglais, commentaires et documentation en français.**
- **Conventional Commits.** Types valides : `feat`, `fix`, `docs`, `test`, `chore`, `refactor`,
  `perf`, `build`, `ci`, `style`, `revert`. Rien d'autre ne passe le hook.
- **`back/src/room.ts` n'importe ni `ws` ni `fastify`** — règle Biome. `draft.ts` doit rester
  aussi propre.
- **Jamais un objet par entité** — tableaux typés.
- **Aucune source de non-déterminisme dans `shared/`** : ni `Math.random`, ni `Date.now`, ni
  itération sur `Map`/objet dont l'ordre compte.
- **Aucun fichier dérivé de Tiny Swords dans l'historique** — la CI échoue sinon.
- `npm run format` avant chaque commit ; `lint`, `typecheck`, `test`, `build -w front` verts.
- **`noUncheckedIndexedAccess` est actif.** Préférer `?? 0` à un `as T`.
- **Ne jamais tuer un processus par motif** (`pkill -f`) : l'auteur joue sur les serveurs de
  développement des ports 5173 et 3100.

## Ce que l'étape 3 a appris, et qui vaut pour ce plan

Trois choses, parce qu'elles ont coûté cher :

**Appliquer la mutation, ne pas la raisonner.** Quinze tests de l'étape 3 se sont avérés
incapables d'attraper le défaut qu'ils nommaient — dont six trouvés par les implémenteurs
eux-mêmes. Aucun n'était visible à la lecture. Le motif ne varie jamais : *le test met en scène
la bonne intention et rate la ligne qu'il nomme.*

**Le plan se trompe plus souvent que le code.** Onze défauts de l'étape 3 venaient du plan.
Chaque fois, l'implémenteur avait raison de signaler la contradiction. **Signaler plutôt que
choisir en silence.**

**La vérification manuelle est un instrument, pas une formalité.** Quinze des vingt-huit tâches
de l'étape 3 sont nées de l'auteur en train de jouer, et aucune n'aurait été trouvée autrement.

## Cohérence des constantes

> À l'étape 3, ce tableau a évité plusieurs défauts et en a causé un : `SEPARATION_STRENGTH` y
> était donnée comme « réglage de sensation, sans effet sur le déterminisme » — vrai pour le
> déterminisme, faux pour le coût, dont c'était le principal levier. **Le tableau ne protège que
> si les contraintes qu'on y écrit sont les bonnes.**

| Constante | Valeur | Contrainte |
| --- | --- | --- |
| `DRAFT_WINDOW_TICKS` | 600 (20 s) | plafond du §7.4, **à plusieurs seulement** ; en solo la fenêtre se referme au clic |
| `DRAFT_REPICK_TICKS` | 150 (5 s) | §7.2 point 4 |
| `LEVEL_RESUME_TICKS` | 30 | existant, inchangé — la rampe de reprise de l'étape 3 |
| ~~`LEVEL_FREEZE_TICKS`~~ | **supprimée en tâche 6, pas avant** | valeur provisoire de l'étape 3. Elle a **six** usages dans `back/` **et** `front/` : la retirer plus tôt casse le build entre deux tâches |
| `WEAPON_SLOTS` | 5 | §6.1 — **toutes draftées**, aucune attribuée d'avance |
| `PASSIVE_SLOTS` | 3 | §6.1 ; l'extension à 6 par événements est hors étape |
| `WEAPON_MAX_LEVEL` | 5 | au-delà, la carte proposée devient l'évolution (§7.5) |
| `SPREAD_BONUS` | 3 | l'étalage fait `joueurs + 3` cartes (§7.2 point 1) |

> ⚠️ **`SPREAD_BONUS` a une contrainte non évidente.** L'étalage doit rester **strictement plus
> grand que le nombre de joueurs**, sinon une repioche peut n'avoir plus rien à offrir. À 4
> joueurs et 7 cartes, quatre prises laissent trois cartes : la borne tient. La changer sans
> vérifier ça casse la repioche du §7.2 point 4.

## Structure des fichiers

| Fichier | Responsabilité |
| --- | --- |
| `shared/passives.ts` | table des passifs, pilotée par la donnée — l'index **est** l'identifiant |
| `shared/weapons.ts` | + niveau maximum, passif d'évolution requis |
| `shared/cards.ts` | le type `Card`, les quatre natures, le tirage d'un étalage |
| `shared/loadout.ts` | l'inventaire d'un joueur : armes et niveaux, passifs empilés |
| `shared/protocol.ts` | + `DRAFT_OPEN`, `DRAFT_TOKEN`, `DRAFT_INTENTS`, `DRAFT_RESULT` |
| `back/src/draft.ts` | la machine à états, testable sans serveur |
| `back/src/room.ts` | intègre le draft au gel ; tire depuis les slots |
| `front/src/net/client.ts` | reçoit les messages, expose l'état de draft |
| `front/src/ui/draft.ts` | l'écran : cartes, jetons, révélation |

---

## Tâche 1 : le catalogue — passifs, et armes qui montent

**Fichiers :**
- Créer : `shared/passives.ts`, `shared/passives.test.ts`
- Modifier : `shared/weapons.ts`, `shared/weapons.test.ts`, `shared/constants.ts`

**Interfaces :**
- Produit :
  ```ts
  export interface Passive { id: number; name: string; /** Bonus par carte prise. */ magnitude: number; kind: PassiveKind }
  export const PASSIVES: readonly Passive[]
  export function passiveOf(id: number): Passive   // leve sur un identifiant inconnu
  // sur Weapon, deux champs nouveaux :
  //   maxLevel: number
  //   evolutionPassiveId: number   // -1 : cette arme n'evolue pas
  ```

- [ ] **Étape 1 : les constantes**, avec leur contrainte en commentaire — pas seulement leur
  valeur. Reprendre le tableau ci-dessus mot pour mot, `SPREAD_BONUS` et sa borne comprises.

- [ ] **Étape 2 : la table des passifs.** 4 à 6 entrées, suivant le motif d'`archetypes.ts` :
  l'index dans le tableau **est** l'identifiant, aucune correspondance à synchroniser.

  Les passifs s'**empilent** (§3.3 de la spec) : `magnitude` est le bonus **par carte prise**, pas
  un total. Choisir des `kind` qui touchent des nombres déjà existants et mesurables — cadence de
  tir, dégâts, points de vie maximum, vitesse — pour que la tâche 8 puisse les vérifier.

- [ ] **Étape 3 : étendre `Weapon`.** Porter la table de 4 à 8-10 armes. Au moins **une paire
  arme/passif qui permette une évolution**, sinon cette nature de carte ne sera jamais testée.

- [ ] **Étape 4 : les tests.** Indexation cohérente, valeurs strictement positives, `passiveOf`
  qui **lève** sur un identifiant inconnu plutôt que de rendre `undefined` — même contrat que
  `weaponOf` et `archetypeOf`.

  ⚠️ Un test doit vérifier qu'`evolutionPassiveId` désigne un passif **existant** quand il n'est
  pas `-1`. Une référence morte ne se verrait nulle part avant que quelqu'un drafte cette arme.

- [ ] **Étape 5 : commit** — `feat(shared): catalogue des passifs et niveaux d'armes`

---

## Tâche 2 : `shared/loadout.ts` — ce qu'un joueur possède

**Fichiers :** créer `shared/loadout.ts`, `shared/loadout.test.ts`

**Interfaces :**
- Produit :
  ```ts
  export class Loadout {
    get weaponIds(): readonly number[]          // dans l'ordre d'acquisition
    levelOf(weaponId: number): number           // 0 = pas possedee
    stacksOf(passiveId: number): number         // 0 = aucune carte prise
    get weaponSlotsUsed(): number
    get passiveSlotsUsed(): number
    addWeapon(weaponId: number): void           // leve si slots pleins ou deja possedee
    levelUpWeapon(weaponId: number): void       // leve si non possedee ou deja au max
    addPassive(passiveId: number): void         // empile ; leve si un NOUVEAU passif ne rentre pas
    bonus(kind: PassiveKind): number            // somme des magnitudes empilees
  }
  ```

- [ ] **Étape 1 : les tests d'abord**, chacun nommant sa mutation :

  - une arme ajoutée deux fois **lève** — l'exclusivité du §6.2 est binaire ;
  - `addWeapon` au-delà de `WEAPON_SLOTS` **lève** ;
  - un passif pris deux fois **empile** : `stacksOf` vaut 2, `bonus` double ;
  - un passif déjà possédé ne consomme **pas** de slot supplémentaire — c'est ce qui distingue
    l'empilement de l'acquisition ;
  - un **nouveau** passif au-delà de `PASSIVE_SLOTS` lève ;
  - `levelUpWeapon` au-delà de `WEAPON_MAX_LEVEL` lève.

  ⚠️ Le quatrième test est celui qui porte le modèle Risk of Rain. Sans lui, une implémentation
  qui consomme un slot par carte de passif passerait — et trois cartes rempliraient l'inventaire.

- [ ] **Étape 2 : vérifier l'échec**, puis implémenter. Tableaux typés, jamais un objet par
  entrée : le catalogue est petit et fixe, deux `Uint8Array` indexées par identifiant suffisent.

- [ ] **Étape 3 : commit** — `feat(shared): l'inventaire d'un joueur, armes et passifs empiles`

---

## Tâche 3 : `shared/cards.ts` — la carte et le tirage

**Fichiers :** créer `shared/cards.ts`, `shared/cards.test.ts`

**Interfaces :**
- Consomme : `Loadout`, `WEAPONS`, `PASSIVES`.
- Produit :
  ```ts
  export const CARD = { NEW_WEAPON: 0, WEAPON_LEVEL: 1, PASSIVE: 2, EVOLUTION: 3 } as const;
  export interface Card { nature: number; refId: number; owner: number }  // owner 0 = ouvert a tous
  export function drawSpread(
    loadouts: ReadonlyMap<number, Loadout>,   // par identifiant de joueur
    rng: () => number,
  ): Card[]
  ```

  ⚠️ `rng` est **injecté**, jamais `Math.random` : `shared/` l'interdit, et un tirage injecté se
  teste avec une graine fixe. Le serveur seul l'appelle, avec sa propre source.

- [ ] **Étape 1 : les tests d'abord.** Chacun nomme sa mutation.

  - l'étalage fait `joueurs + SPREAD_BONUS` cartes ;
  - une arme **portée par n'importe quel membre** de l'équipe n'apparaît jamais en `NEW_WEAPON` —
    c'est l'exclusivité du §6.2, à l'échelle de l'équipe et non du joueur ;
  - une carte `WEAPON_LEVEL` porte l'`owner` du **porteur**, jamais 0 ;
  - une carte `PASSIVE` porte toujours `owner = 0`, **même si un joueur la possède déjà** — les
    passifs s'empilent, il n'y a rien à exclure ;
  - une arme au niveau maximum dont le joueur possède le passif requis produit une `EVOLUTION` ;
  - la même graine donne le même étalage.

  ⚠️ Le deuxième test est le seul qui porte l'exclusivité d'équipe. Le monter avec **deux
  inventaires**, dont un seul possède l'arme : un test à un seul joueur passerait avec une
  exclusion purement personnelle, qui est un tout autre comportement.

- [ ] **Étape 2 : vérifier l'échec**, puis implémenter.

- [ ] **Étape 3 : commit** — `feat(shared): tirage d'un etalage de cartes`

---

## Tâche 4 : le protocole

**Fichiers :** modifier `shared/protocol.ts`, `shared/protocol.test.ts`

**Interfaces :**
- Produit : `MSG.DRAFT_OPEN = 9`, `DRAFT_TOKEN = 10`, `DRAFT_INTENTS = 11`, `DRAFT_RESULT = 12`,
  et leurs encodeurs/décodeurs.

Dispositions, dans le style des huit messages existants :

| Message | Disposition | Octets |
| --- | --- | --- |
| `DRAFT_OPEN` | `type u8 · deadlineTick u32 · count u8 · (nature u8 · refId u8 · owner u8) × count` | 6 + 3n |
| `DRAFT_TOKEN` | `type u8 · cardIndex u8` (255 = aucun) | 2 |
| `DRAFT_INTENTS` | `type u8 · count u8 · (playerId u8 · cardIndex u8) × count` | 2 + 2n |
| `DRAFT_RESULT` | `type u8 · phase u8 · deadlineTick u32 · count u8 · (playerId u8 · cardIndex u8 · outcome u8) × count` | 7 + 3n |

`outcome` : `0 = obtenue`, `1 = perdue au conflit`, `2 = attribuée d'office`. C'est lui qui dit à
l'écran s'il faut **illuminer** ou **consumer** la carte (§4.2 de la spec).

`phase` : `0 = draft termine`, `1 = repioche ouverte`. Et `deadlineTick` se lit selon `phase` —
l'échéance de la repioche, ou le tick auquel le gel prend fin.

> ⚠️ **Ce champ n'était pas dans la première version de la spec, et son absence était un défaut.**
> À l'étape 3, le client calculait la fin du gel lui-même :
> `#freezeUntilTick = msg.tick + LEVEL_FREEZE_TICKS - 1`. C'était possible parce que le gel durait
> une constante.
>
> **Ce n'est plus le cas.** La fenêtre dure jusqu'à ce que tout le monde ait posé son jeton, et en
> solo elle se ferme au clic. Le client **ne peut plus déduire** la fin du gel : le serveur doit
> la lui dire. Sans ce champ, chaque client devinerait une fin différente — exactement la
> divergence que le gel daté par tick de l'étape 3 existait pour empêcher.

- [ ] **Étape 1 : les tests**, avec la discipline établie à l'étape 3 : aller-retour, **taille
  totale exacte** contre les constantes, et **tampon tronqué qui lève**.

  ⚠️ Un aller-retour seul **ne peut pas** attraper une erreur de décalage d'octet : l'encodeur et
  le décodeur partagent la faute. C'est la taille totale qui l'attrape.

- [ ] **Étape 2 : implémenter.** `DRAFT_OPEN` et `DRAFT_RESULT` ont la même forme
  « en-tête + liste de triplets » — **factoriser**, comme `encodeIdBatch` l'a été pour
  `DEATHS`/`PICKUPS`.

- [ ] **Étape 3 : vérifier que le test de trafic réseau de l'étape 2 passe toujours sans
  édition.** Il dérive son plafond des constantes de snapshot ; le draft ne doit pas s'y ajouter.

- [ ] **Étape 4 : commit** — `feat(shared): messages du draft`

---

## Tâche 5 : `back/src/draft.ts` — la machine à états

**Fichiers :** créer `back/src/draft.ts`, `back/src/draft.test.ts`

**Interfaces :**
- Produit :
  ```ts
  export type DraftPhase = 'closed' | 'open' | 'repick';
  export interface DraftOutcome { playerId: number; cardIndex: number; outcome: number }
  export class Draft {
    get phase(): DraftPhase
    get deadlineTick(): number
    open(tick: number, spread: Card[], playerIds: readonly number[], soloMode: boolean): void
    setToken(playerId: number, cardIndex: number): boolean   // false si inéligible
    intents(): ReadonlyMap<number, number>
    /** Fait avancer la machine. Rend les issues quand une phase se ferme, sinon null. */
    step(tick: number, rng: () => number): DraftOutcome[] | null
  }
  ```

⚠️ **`draft.ts` ne connaît ni `ws` ni `fastify`**, comme `room.ts` et `combat.ts`. Il ne connaît
pas non plus `Room` : il reçoit des identifiants et des cartes, il rend des issues.

- [ ] **Étape 1 : les tests, écrits avant le code.** Cette tâche n'a pas de code fourni ici — la
  machine est simple mais ses cas sont nombreux, et un test écrit contre le code réel vaudra mieux
  que celui que j'écrirais d'avance. **Pour chacun, nommer la mutation, l'appliquer, la vérifier.**

  Les cas qui doivent exister :
  - un jeton posé sur une carte dont `owner` n'est pas le joueur est **refusé** ;
  - un jeton se déplace tant que la fenêtre est ouverte ;
  - deux jetons sur la même carte : **un seul gagnant**, les autres en `outcome = 1` ;
  - le gagnant est tiré du `rng` injecté — deux graines différentes donnent deux gagnants ;
  - un joueur sans jeton à l'échéance reçoit l'**attribution d'office** ;
  - la repioche s'ouvre pour les perdants, et **pour eux seuls** ;
  - **la repioche ne boucle pas** : un reconflit se tranche et se termine ;
  - en solo, la fenêtre se ferme **au jeton posé**, sans attendre d'échéance.

- [ ] **Étape 2 : l'attribution d'office**, telle que le §4.4 de la spec la définit :

  1. la carte dont il est le seul éligible (`owner` à son identifiant), s'il y en a une ;
  2. sinon la première carte libre de l'étalage, dans l'ordre du tirage.

  ⚠️ Un test doit vérifier la **propriété** qui en découle, pas seulement la règle : *un joueur
  absent ne prive jamais un joueur présent d'une carte qu'il vise.* C'est ce que la règle est
  censée garantir, et c'est ce qui casserait si quelqu'un « simplifiait » l'ordre.

- [ ] **Étape 3 : commit** — `feat(back): machine a etats du draft`

---

## Tâche 6 : intégration au salon

**Fichiers :** modifier `back/src/room.ts`, `back/src/room.test.ts`, `back/src/server.ts`,
`front/src/net/client.ts`

**Interfaces :**
- Produit : `PlayerState` gagne `loadout: Loadout` — **c'est ici qu'il naît**, et les tâches 7 et
  8 le consomment.
- La source aléatoire du draft se dérive de `mapSeed`, comme le générateur de vagues le fait déjà
  (`new WaveDirector(this.mapSeed ^ 0x5bf0_3a17)`). Une constante de mélange différente, pour que
  deux tirages indépendants ne se suivent pas.

- [ ] **Étape 0 : retirer `LEVEL_FREEZE_TICKS`.** Elle a **six usages**, dans `back/src/room.ts`,
  `back/src/room.test.ts`, `front/src/net/client.ts` et `front/src/net/client.test.ts`. Le client
  s'en sert à deux endroits : pour dater la fin du gel à la réception du `LEVEL_UP`, et pour
  calculer `isFrozen`.

  **Les deux doivent désormais venir du serveur**, via le `phase`/`deadlineTick` de
  `DRAFT_RESULT` — voir la tâche 4. C'est la partie la moins évidente de cette tâche.

- [ ] **Étape 1 : le gel devient la fenêtre du draft.** `LEVEL_FREEZE_TICKS` disparaît ; la durée
  du gel est celle du draft, qui se referme quand la machine passe en `closed`.

  ⚠️ **Le gel reste daté par tick.** L'étape 3 l'a établi et mesuré : sans ça, chaque client fige à
  la réception, donc à un tick différent selon sa latence, et le gel devient une source de
  divergence. Le `LEVEL_UP` existant porte déjà le tick d'effet — le conserver.

- [ ] **Étape 2 : les gels s'enchaînent déjà.** `freezeStart = max(tick, resumeEndTick) + 1` :
  plusieurs niveaux gagnés d'un coup mettent leurs drafts bout à bout. Vérifier que ça tient avec
  une fenêtre de 20 s au lieu de 2 — **un test qui gagne deux niveaux en un tick**.

- [ ] **Étape 3 : diffusion**, dans `server.ts`, dans l'ordre déjà établi : les messages de draft
  partent **avant le snapshot du même tick**, comme les ordres de vague et les morts. Compter les
  octets dans `#wireBytes`.

- [ ] **Étape 4 : commit** — `feat(back): le gel de niveau ouvre le draft`

---

## Tâche 7 : l'arme draftée tire

**Fichiers :** modifier `back/src/room.ts`, `back/src/room.test.ts`

C'est ici que l'étape cesse d'être un menu.

`Room#fireWeapons` est câblé en dur sur `weaponOf(0)` — l'arme neutre. Il doit parcourir les
slots.

- [ ] **Étape 1 : le test d'abord.** Un joueur qui drafte une arme tire **avec elle en plus** de
  l'arme neutre. Vérifier la **cadence propre** de chaque arme, pas seulement que des projectiles
  existent : un `lastFireTick` unique pour toutes les armes ferait passer un test naïf tout en
  bridant l'arsenal à la cadence la plus lente.

  ⚠️ `PlayerState.lastFireTick` devient **un par arme**. C'est le vrai changement de cette tâche,
  et le test doit le porter.

- [ ] **Étape 2 : l'arme neutre reste hors slots** (§6.1) et tire toujours. Un test qui prend cinq
  armes et vérifie qu'on tire six fois.

- [ ] **Étape 3 : commit** — `feat(back): tirer avec les armes draftees`

---

## Tâche 8 : le passif change un nombre

**Fichiers :** modifier `back/src/room.ts`, `back/src/combat.ts`, leurs tests

- [ ] **Étape 1 : brancher `Loadout.bonus(kind)`** là où le nombre est lu — cadence, dégâts,
  points de vie, vitesse selon les `kind` retenus à la tâche 1.

- [ ] **Étape 2 : le test qui compte.** Prendre **deux fois la même carte** de passif et vérifier
  que le bonus **double**. C'est l'empilement du modèle Risk of Rain, et c'est la seule
  vérification qui distingue « le passif marche » de « le passif s'empile ».

- [ ] **Étape 3 : commit** — `feat(back): les passifs empiles modifient le combat`

---

## Tâche 9 : le client reçoit le draft

**Fichiers :** modifier `front/src/net/client.ts`, `front/src/net/client.test.ts`

- [ ] **Étape 1 : recevoir et exposer.** `GameClient` gagne un état de draft en lecture :
  l'étalage, les jetons des autres, l'échéance, les issues quand elles arrivent. Il n'en **décide**
  rien — le §7.2 est catégorique.

- [ ] **Étape 2 : envoyer le jeton.** Un `DRAFT_TOKEN` part quand le joueur pose ou déplace son
  jeton. Pas de cadence fixe : c'est un geste, pas une entrée continue.

- [ ] **Étape 3 : le gel du draft réutilise l'existant.** `#movementScale` et la prédiction locale
  honorent déjà le gel depuis l'étape 3 — vérifier, ne pas réécrire.

- [ ] **Étape 4 : les tests**, avec des mutations appliquées. Au minimum : un jeton refusé par le
  serveur ne s'affiche pas comme posé ; les issues d'un autre joueur ne modifient pas mon
  inventaire.

- [ ] **Étape 5 : commit** — `feat(front): reception du draft`

---

## Tâche 10 : l'écran

**Fichiers :** créer `front/src/ui/draft.ts` ; modifier `front/index.html`, `front/src/main.ts`

Fonctionnel et lisible — le soin visuel viendra quand les cartes auront un élément à porter
(étape 5).

- [ ] **Étape 1 : les cartes et les jetons.** L'étalage, l'avatar de chaque joueur sur la carte
  qu'il vise, le chronomètre. **C'est la visibilité des intentions qui fait exister la mécanique**
  (§7.2 point 3) — sans elle il n'y a pas de négociation, seulement un menu.

- [ ] **Étape 2 : la révélation.** La même carte **s'illumine** chez le gagnant et **se consume**
  chez les perdants, simultanément. Puis la repioche, et la carte finalement obtenue s'illumine
  pour confirmer.

  C'est ce traitement qui remplace la rotation de priorité supprimée : il rend la perte **lisible**
  plutôt que subie. Le §9 de la spec en fait la contrepartie explicite de l'aléatoire pur.

- [ ] **Étape 3 : commit** — `feat(front): l'ecran de draft`

---

## Tâche 11 : quatre clients, en headless

**Fichiers :** créer ou étendre un test d'intégration dans `back/`

C'est le livrable du §13.

- [ ] **Étape 1 : quatre clients** connectés à un salon, qui montent de niveau, draftent, entrent
  en conflit, repiochent.

  ⚠️ **Pourquoi headless et pas quatre onglets :** `requestAnimationFrame` est suspendu dans un
  onglet en arrière-plan — mesuré à l'étape 2, zéro image en quinze secondes. Trois des quatre
  onglets ne dessineraient rien.

- [ ] **Étape 2 : ce que le test doit assener**, et pas seulement « ça n'a pas planté » :
  - un conflit **a eu lieu** — sinon le test ne prouve rien, et c'est le défaut le plus probable ;
  - un seul joueur obtient la carte contestée ;
  - les perdants obtiennent une carte à la repioche ;
  - un joueur qui ne pose aucun jeton reçoit son attribution d'office sans bloquer les autres ;
  - **les trois chiffres de réplication restent à 0,000 px.**

- [ ] **Étape 3 : commit** — `test(back): quatre joueurs draftent et un conflit se resout`

---

## Tâche 12 : vérification manuelle et clôture

- [ ] **Jouer une run, au premier plan.** Un onglet en arrière-plan a son `requestAnimationFrame`
  suspendu ; la poignée `window.__tarnok` permet d'avancer les images à la main.

- [ ] **Ce qui relève du jugement**, et que rien n'automatise : le draft est-il un **moment**, ou
  une interruption ? Vingt secondes, est-ce trop long à quatre ? La perte d'un conflit se
  comprend-elle sans explication ? Une arme draftée **se sent-elle** différente ?

- [ ] **Rejouer les trois bancs** — le tir depuis plusieurs slots change le coût du tick.

- [ ] Écrire `docs/plans/2026-08-26-etape-4-resultats.md` et mettre à jour le `README.md`.

- [ ] **Commit** — `docs: resultats de l'etape 4`

---

## Auto-relecture

**Couverture de la spec.** §1 périmètre → tâches 1 et 10 ; §2 non-atteinte à la réplication →
tâche 11 étape 2 ; §3.1 modèle de carte → tâche 3 ; §3.2 `owner` → tâches 3 et 5 ; §3.3
empilement → tâches 2 et 8 ; §3.4 exclusions → tâche 3 ; §4 machine à états → tâche 5 ; §4.1
jeton → tâches 5, 9, 10 ; §4.2 révélation → tâche 10 ; §4.3 fenêtres → tâches 1 et 6 ; §4.4
bornes → tâche 5 ; §5 protocole → tâche 4 ; §6 slots → tâche 2 ; §7 effet réel → tâches 7 et 8 ;
§8 vérification → tâches 5, 11, 12 ; §9 écarts → consignés dans la spec, rien à implémenter.

**Cohérence des constantes.** Toutes celles introduites figurent au tableau avec ce qui les
contraint. La seule contrainte non évidente — `SPREAD_BONUS` doit garder l'étalage strictement
plus grand que le nombre de joueurs, sinon la repioche n'a plus rien à offrir — y est écrite.

**Cohérence des types.** `Card` est défini une fois en tâche 3 et consommé tel quel en 4, 5 et 9.
`owner` est un identifiant de joueur (0 = ouvert), jamais un masque — la généralisation en masque
d'éligibilité a été abandonnée avec le modèle de repli du §7.3.

**Un piège à surveiller à l'exécution.** La tâche 7 transforme `lastFireTick` en un compteur par
arme. C'est un changement de forme dans `PlayerState`, que le rejeu du client ne connaît pas —
vérifier que rien dans `#replayTick` ne dépend de ce champ. Si quelque chose en dépend, le
signaler plutôt que d'adapter en silence.
