# Étape 8 — les classes : plan d'implémentation

> **Pour les exécutants agentiques :** SOUS-COMPÉTENCE REQUISE — utiliser
> `superpowers:subagent-driven-development` (recommandé) ou `superpowers:executing-plans` pour
> implémenter ce plan tâche par tâche. Les étapes utilisent des cases à cocher (`- [ ]`).

**But :** chaque joueur choisit une classe au salon, et cette classe lui donne une capacité active
que le serveur arbitre et que les deux côtés dérivent identiquement.

**Architecture :** une classe est une donnée partagée (`shared/classes.ts`), annoncée **une fois**
au salon sur le message `PICK` existant. Un verbe est demandé par le client (`ABILITY`), arbitré par
le serveur sur une recharge, puis **annoncé** (`ABILITY_USED`) et dérivé des deux côtés — le patron
de `BOSS_CHARGE`. Aucun octet n'est ajouté à l'instantané.

**Pile :** TypeScript, npm workspaces (`front`, `back`, `shared` via `@shared/*`), Vitest, Biome,
PixiJS v8, WebSocket binaire.

**Spec :** [`docs/specs/2026-10-13-etape-8-classes.md`](../specs/2026-10-13-etape-8-classes.md)

⚠️ **DÉPENDANCE DURE, à vérifier avant la tâche 1.** La salle d'attente (`LOBBY: 21`, `PICK: 22`,
`START: 23`, `startingWeapons()`, `NO_WEAPON = 255`, `front/src/ui/room.ts`) doit être **committée et
verte**. Au moment d'écrire ce plan elle ne l'était pas : 27 fichiers modifiés et 5 fichiers neufs
dans l'arbre de travail, dont `shared/lobby.test.ts` sans son module. **Si `git status` n'est pas
propre, arrêter et le dire** — les tâches 2 et 8 touchent exactement ces fichiers.

## Contraintes globales

- **Zéro octet de plus par tick.** `SNAPSHOT_PLAYER_BYTES` reste à **10**. La classe voyage une fois
  sur `PICK`/`LOBBY` ; le verbe s'annonce à l'usage, jamais périodiquement.
- **Les identifiants de message sont 24 (`ABILITY`) et 25 (`ABILITY_USED`)** — les premiers libres
  après `START: 23`.
- **Une classe ne porte jamais d'élément ni d'arme**, et le type `GameClass` ne doit pas pouvoir en
  porter : le garde est le système de types, pas un test textuel.
- **Les traits changent une RÈGLE, jamais un nombre.** La boutique vend déjà `puissance`, `armure`,
  `vitalite`, `regain`, `celerite`, `aimant`, `cadence`, `savoir`, `fortune` : un trait chiffré
  doublerait la boutique.
- **Les doublons de classe sont libres** : deux joueurs du même salon peuvent prendre la même.
- **Les réglages de jeu ne se codent jamais en dur dans un test** — recharges, rayons, durées se
  lisent de leur source. **Les largeurs de fil et les identifiants de message s'épinglent en nombres
  nus** : un test qui importe la constante qu'il vérifie ne vérifie rien.
- **Une largeur se calcule, jamais ne se devine.**
- **Le client PROPOSE, le salon arbitre.** Un verbe refusé n'est pas enregistré, et le refus est
  silencieux — même discipline que `DRAFT_TOKEN` et `VOTE`.
- **Annonce une fois, dérive ensuite.** Le serveur n'envoie jamais l'effet d'un verbe, seulement son
  déclenchement daté.
- **Un docbloc faux est un bug** : treize corrigés dans ce dépôt.
- Attribution de commit : terminer chaque message par
  `Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83`

## Review Focus

Les cinq classes d'entrée que la spec implique et qu'aucune tâche n'exerce spontanément, la plus
probable d'abord. Chacune reçoit son test dans la tâche qui possède le code.

1. **Un `classId` inconnu, hors catalogue, ou absent du message.** Le client peut envoyer n'importe
   quoi. Attendu : le choix n'est pas enregistré, exactement comme une arme hors liste — et le joueur
   garde la classe par défaut plutôt que de se retrouver sans verbe. → tâche 2.
2. **Un verbe demandé par un joueur mort, ou après la fin de la run.** Attendu : refus silencieux,
   aucune annonce, aucun effet. → tâche 3.
3. **Deux `ABILITY` dans le même tick, ou un spam à 30 Hz.** Attendu : un seul passe, les autres
   tombent sur la recharge — et la recharge est lue du **tick arbitré par le serveur**, jamais d'un
   compteur client. → tâche 3.
4. **Un Relais vers un allié qui vient de se déconnecter, ou vers soi-même.** Attendu : refus
   silencieux ; aucun joueur ne se téléporte sur une position fantôme. → tâche 7.
5. **Un leurre encore vivant quand son lanceur meurt ou se déconnecte.** Attendu : le leurre expire
   normalement par sa date, et la place du lanceur dans l'entrée du champ redevient la sienne sans
   trou — un `seen.x` décalé d'un cran ferait **dériver toute la horde**. → tâche 6.

## Structure des fichiers

| Fichier | Responsabilité |
| --- | --- |
| `shared/classes.ts` | **Créé.** Le catalogue : quatre `GameClass` gelées, `VerbKind`, `TraitKind`, `classOf(id)`, `DEFAULT_CLASS_ID`. Données pures, aucun effet. |
| `shared/classes.test.ts` | **Créé.** Le catalogue et ses invariants. |
| `shared/protocol.ts` | **Modifié.** `LobbyEntry` gagne `classId` ; `encodePick` gagne un paramètre ; `ABILITY` et `ABILITY_USED`. |
| `shared/abilities.ts` | **Créé.** Les constantes de réglage des quatre verbes (recharges, rayons, durées) et `ABILITY_COOLDOWN_TICKS[verb]`. Un seul endroit à relire au playtest. |
| `back/src/room.ts` | **Modifié.** `PlayerState` gagne `classId` et `lastAbilityTick` ; `Room#useAbility` arbitre ; les quatre effets. |
| `back/src/server.ts` | **Modifié.** `PICK` enregistre la classe ; `ABILITY` est relayé à `Room` ; `ABILITY_USED` est diffusé. |
| `front/src/net/client.ts` | **Modifié.** Envoie `ABILITY`, reçoit `ABILITY_USED`, dérive les quatre effets dans son miroir. |
| `front/src/ui/room.ts` | **Modifié.** Le choix de classe sur l'écran d'attente. |
| `back/src/classes.integration.test.ts` | **Créé.** Le livrable : vraies sockets, les quatre verbes, et la dérive à 0,000 px. |

---

## Tâche 1 : le catalogue des classes

**Files :**
- Create: `shared/classes.ts`
- Create: `shared/classes.test.ts`

**Interfaces :**
- Consumes: rien.
- Produces: `interface GameClass { readonly id: number; readonly label: string; readonly verb: VerbKind; readonly trait: TraitKind }` ;
  `type VerbKind = 'amorce' | 'rempart' | 'appat' | 'relais'` ;
  `type TraitKind = 'residuPartout' | 'remparteAllie' | 'leurreElementaire' | 'relaisIntangible'` ;
  `CLASSES: readonly GameClass[]` ; `classOf(id: number): GameClass | undefined` ;
  `DEFAULT_CLASS_ID = 0`.

- [ ] **Étape 1 : écrire les tests qui échouent**

`shared/classes.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { CLASSES, classOf, DEFAULT_CLASS_ID, type GameClass } from './classes';

describe('etape 8 tache 1 : le catalogue des classes', () => {
  it('porte exactement quatre classes, aux identifiants 0 a 3', () => {
    // ⚠️ Nombre NU : c'est une decision de la spec (§6), pas un reglage de jeu.
    expect(CLASSES.length).toBe(4);
    expect(CLASSES.map((c) => c.id)).toEqual([0, 1, 2, 3]);
  });

  it('chaque classe a un verbe et un trait DISTINCTS des autres', () => {
    expect(new Set(CLASSES.map((c) => c.verb)).size).toBe(CLASSES.length);
    expect(new Set(CLASSES.map((c) => c.trait)).size).toBe(CLASSES.length);
  });

  it('aucune classe ne porte d element ni d arme — le TYPE ne le permet pas', () => {
    // ⚠️ Ce test n'est PAS le garde structurel : le garde, c'est que `GameClass`
    // n'a aucun champ d'element ni d'arme. Un test textuel serait du theatre —
    // la lecon de la tache 1 de l'etape 7b. Celui-ci epingle seulement que les
    // clefs du catalogue restent les quatre attendues, donc qu'aucune n'a ete
    // ajoutee en douce.
    for (const c of CLASSES) {
      expect(Object.keys(c).sort()).toEqual(['id', 'label', 'trait', 'verb']);
    }
  });

  it('classOf rend la classe par son identifiant, et undefined hors catalogue', () => {
    expect(classOf(DEFAULT_CLASS_ID)?.id).toBe(DEFAULT_CLASS_ID);
    expect(classOf(CLASSES.length)).toBeUndefined();
    expect(classOf(-1)).toBeUndefined();
    expect(classOf(255)).toBeUndefined();
  });

  it('la classe par defaut existe dans le catalogue', () => {
    expect(classOf(DEFAULT_CLASS_ID)).toBeDefined();
  });

  it('le catalogue est gele : une ecriture ne passe pas', () => {
    const premiere = CLASSES[0] as GameClass;
    expect(() => {
      (premiere as { label: string }).label = 'autre';
    }).toThrow();
  });
});
```

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run ../shared/classes.test.ts
```

Attendu : ÉCHEC — `Cannot find module './classes'`.

- [ ] **Étape 3 : écrire le catalogue**

`shared/classes.ts` :

```ts
/**
 * Les classes : **un verbe et un trait, jamais un element, jamais une arme.**
 *
 * ⚠️ **Le garde est ce TYPE, pas un test.** `GameClass` n'a aucun champ
 * d'element ni d'arme, donc une classe ne peut pas en porter — c'est la lecon
 * de la tache 1 de l'etape 7b, ou un test qui cherchait un motif textuel pour
 * prouver qu'aucun slot d'arme n'etait vendu etait du theatre : le garde reel
 * etait le systeme de types.
 *
 * ⚠️ **La raison du §6.7 de l'orientation est caduque, sa conclusion tient.**
 * Ce paragraphe justifiait les verbes PARCE QUE l'element devait rester l'enjeu
 * du draft. La salle d'attente fait desormais choisir l'arme de depart, donc
 * l'element, avant la partie. Mais puisque le salon traite deja l'arme, la
 * classe a un metier propre et sans recouvrement — la division du travail est
 * maintenant nette au lieu d'etre defensive. Voir §2 de la spec de l'etape 8.
 */
export type VerbKind = 'amorce' | 'rempart' | 'appat' | 'relais';

/**
 * Un trait change une REGLE, jamais un nombre.
 *
 * ⚠️ **Contrainte dure, et elle vient de l'etape 7b.** La boutique vend deja
 * neuf bonus CHIFFRES de statistiques de depart. Un trait chiffre ferait d'une
 * classe « un article de boutique gratuit, plus un verbe », et les deux
 * systemes se marcheraient dessus.
 */
export type TraitKind =
  /** Toute reaction declenchee dans vos zones laisse un effet au sol, pas seulement trois sur quinze (§6.4). */
  | 'residuPartout'
  /** Votre reduction de degats protege aussi l'allie adjacent. */
  | 'remparteAllie'
  /** Votre leurre porte l'element de votre arme. */
  | 'leurreElementaire'
  /** L'allie concerne par votre Relais est brievement intangible. */
  | 'relaisIntangible';

export interface GameClass {
  readonly id: number;
  readonly label: string;
  readonly verb: VerbKind;
  readonly trait: TraitKind;
}

/**
 * ⚠️ **L'ordre fixe les identifiants, et ils voyagent sur le fil** (`PICK`,
 * `LOBBY`). Inserer une classe au milieu changerait le verbe de tout le monde :
 * on ajoute a la FIN, jamais au milieu.
 */
export const CLASSES: readonly GameClass[] = Object.freeze([
  Object.freeze({ id: 0, label: 'Amorce', verb: 'amorce', trait: 'residuPartout' }),
  Object.freeze({ id: 1, label: 'Rempart', verb: 'rempart', trait: 'remparteAllie' }),
  Object.freeze({ id: 2, label: 'Appât', verb: 'appat', trait: 'leurreElementaire' }),
  Object.freeze({ id: 3, label: 'Relais', verb: 'relais', trait: 'relaisIntangible' }),
] as const);

/**
 * La classe d'un joueur qui n'a rien choisi.
 *
 * ⚠️ **L'absence de choix est un etat VALIDE, jamais un blocage du depart** —
 * meme discipline que `NO_WEAPON` au salon. Un joueur qui ne clique pas doit
 * pouvoir jouer.
 */
export const DEFAULT_CLASS_ID = 0;

export function classOf(id: number): GameClass | undefined {
  return CLASSES.find((c) => c.id === id);
}
```

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/classes.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/classes.ts shared/classes.test.ts
git commit -m "feat(shared): le catalogue des quatre classes

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 2 : la classe voyage au salon

**Files :**
- Modify: `shared/protocol.ts` (`LobbyEntry`, `LOBBY_ENTRY_BYTES`, `encodeLobby`, `encodePick`, `PICK_BYTES`, `decode`)
- Modify: `shared/lobby.test.ts`
- Modify: `back/src/server.ts` (le gestionnaire de `MSG.PICK`, `#sendLobby`, `#start`)
- Modify: `back/src/lobby.integration.test.ts`

**Interfaces :**
- Consumes: `CLASSES`, `classOf`, `DEFAULT_CLASS_ID` (tâche 1).
- Produces: `LobbyEntry { playerId: number; weaponId: number; classId: number }` ;
  `encodePick(weaponId: number, classId: number): ArrayBuffer` ;
  `PICK_BYTES = 3` ; `LOBBY_ENTRY_BYTES = 3`.

⚠️ **Relis les valeurs réelles avant d'écrire.** À l'écriture de ce plan, `LOBBY_HEADER_BYTES` vaut
3, `LOBBY_ENTRY_BYTES` vaut 2 et `PICK_BYTES` vaut 2, mais ces constantes viennent d'un travail non
committé. **Additionne le format toi-même** et dis-le si le compte ne tombe pas.

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `shared/lobby.test.ts`, ajoute :

```ts
  it('PICK porte la classe en plus de l arme, et fait l aller-retour', () => {
    const buf = encodePick(WEAPONS[1]?.id ?? 1, 2);
    expect(buf.byteLength).toBe(3); // nombre NU : largeur de fil
    const msg = decode(buf);
    expect(msg?.type).toBe(MSG.PICK);
    expect(msg).toMatchObject({ weaponId: WEAPONS[1]?.id ?? 1, classId: 2 });
  });

  it('LOBBY porte la classe de chaque joueur', () => {
    const buf = encodeLobby(1, [
      { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
      { playerId: 2, weaponId: WEAPONS[1]?.id ?? 1, classId: 3 },
    ]);
    // 3 d'en-tete + 2 entrees x 3 octets : CALCULE, pas devine.
    expect(buf.byteLength).toBe(9);
    const msg = decode(buf);
    expect(msg?.type).toBe(MSG.LOBBY);
    expect(msg).toMatchObject({
      players: [
        { playerId: 1, weaponId: NO_WEAPON, classId: 0 },
        { playerId: 2, weaponId: WEAPONS[1]?.id ?? 1, classId: 3 },
      ],
    });
  });

  it('refuse un LOBBY tronque d un octet', () => {
    const buf = encodeLobby(1, [{ playerId: 1, weaponId: NO_WEAPON, classId: 0 }]);
    expect(decode(buf.slice(0, buf.byteLength - 1))).toBeNull();
  });
```

Dans `back/src/lobby.integration.test.ts`, ajoute — **Review Focus n°1** :

```ts
  it('un classId hors catalogue n est PAS enregistre, et le joueur garde la classe par defaut', async () => {
    const code = await salon();
    const ws = await connecte(code);

    // Trois formes d'invalide : au-dela du catalogue, negatif tronque a 255,
    // et la valeur sentinelle des armes employee par erreur.
    for (const mauvais of [CLASSES.length, 255, 200]) {
      ws.send(encodePick(NO_WEAPON, mauvais));
      await attendre(() => true, 'pick', 200);
    }

    const lobby = dernier(ws, MSG.LOBBY);
    expect(lobby?.players[0]?.classId).toBe(DEFAULT_CLASS_ID);
  });

  it('un classId valide est enregistre et rediffuse a tout le salon', async () => {
    const code = await salon();
    const ws = await connecte(code);
    const voulue = CLASSES[2]?.id ?? 2;

    ws.send(encodePick(NO_WEAPON, voulue));
    await attendre(
      () => (dernier(ws, MSG.LOBBY)?.players[0]?.classId === voulue ? true : null),
      'classe rediffusee',
      2000,
    );
    expect(dernier(ws, MSG.LOBBY)?.players[0]?.classId).toBe(voulue);
  });
```

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx vitest run ../shared/lobby.test.ts src/lobby.integration.test.ts
```

Attendu : ÉCHEC — `encodePick` ne prend qu'un argument, et `classId` n'existe pas sur `LobbyEntry`.

- [ ] **Étape 3 : élargir le protocole**

Dans `shared/protocol.ts` : `LobbyEntry` gagne `readonly classId: number`, `LOBBY_ENTRY_BYTES`
passe de 2 à **3**, `PICK_BYTES` de 2 à **3**.

```ts
export function encodePick(weaponId: number, classId: number): ArrayBuffer {
  const buf = new ArrayBuffer(PICK_BYTES);
  const v = new DataView(buf);
  v.setUint8(0, MSG.PICK);
  v.setUint8(1, weaponId);
  v.setUint8(2, classId);
  return buf;
}
```

Et dans `encodeLobby`, à l'intérieur de la boucle, après `weaponId` :

```ts
    v.setUint8(o + 2, p.classId);
```

Le décodage symétrique lit `classId` au même décalage. **Relis l'addition** : l'entrée fait
`playerId u8 · weaponId u8 · classId u8` = 3 octets.

- [ ] **Étape 4 : le serveur enregistre la classe**

Dans `back/src/server.ts`, le gestionnaire de `MSG.PICK`. L'entrée de salon gagne un `classId`
initialisé à `DEFAULT_CLASS_ID`, et :

```ts
      if (msg.type === MSG.PICK) {
        // Meme regle que l'arme : un choix hors catalogue n'est PAS enregistre,
        // et le joueur garde celle qu'il avait — jamais aucune. Le refus est
        // silencieux, le client le verra a la prochaine diffusion (§5 spec).
        const libres = startingWeapons();
        if (msg.weaponId === NO_WEAPON || libres.includes(msg.weaponId)) {
          entry.weaponId = msg.weaponId;
        }
        if (classOf(msg.classId)) {
          entry.classId = msg.classId;
        }
        this.#sendLobby();
      }
```

⚠️ **Les deux choix sont enregistrés indépendamment, et une seule diffusion suit.** Une arme
invalide ne doit pas faire perdre une classe valide envoyée dans le même message.

Puis `#start` passe la classe à `Room#join` (la tâche 3 ajoute le paramètre).

- [ ] **Étape 5 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/lobby.test.ts src/lobby.integration.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/protocol.ts shared/lobby.test.ts back/src/server.ts back/src/lobby.integration.test.ts
git commit -m "feat: la classe se choisit au salon et voyage sur PICK

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 3 : le socle du verbe — le client propose, le salon arbitre

Cette tâche livre **l'annonce, pas les effets**. Son livrable : un verbe demandé hors recharge est
refusé en silence, et un verbe accepté est annoncé à tout le salon avec son tick.

**Files :**
- Modify: `shared/protocol.ts` (`ABILITY: 24`, `ABILITY_USED: 25`, encodeurs, décodeurs, `decode`)
- Create: `shared/abilities.ts`
- Create: `shared/abilities.test.ts`
- Modify: `back/src/room.ts` (`PlayerState`, `join`, `useAbility`)
- Modify: `back/src/server.ts` (relai de `ABILITY`, diffusion de `ABILITY_USED`)
- Modify: `back/src/room.test.ts`

**Interfaces :**
- Consumes: `VerbKind`, `classOf`, `DEFAULT_CLASS_ID` (tâche 1).
- Produces: `encodeAbility(tick: number, aimX: number, aimY: number): ArrayBuffer` ;
  `encodeAbilityUsed(tick: number, playerId: number, verb: number, x: number, y: number, targetId: number): ArrayBuffer` ;
  `ABILITY_BYTES = 9` ; `ABILITY_USED_BYTES = 13` ;
  `Room#join(id, compte?, startWeapon?, classId?)` ; `Room#useAbility(playerId: number, aimX: number, aimY: number): AbilityUsed | null` ;
  `ABILITY_COOLDOWN_TICKS: Readonly<Record<VerbKind, number>>` ; `VERB_IDS: Readonly<Record<VerbKind, number>>` ;
  et le type de l'annonce, **déclaré dans `shared/abilities.ts`** puisque les deux côtés le lisent :

```ts
/** Ce que le salon ANNONCE quand il accepte un verbe. Jamais l'effet, seulement son declenchement. */
export interface AbilityUsed {
  readonly tick: number;
  readonly playerId: number;
  readonly verb: number;
  readonly x: number;
  readonly y: number;
  /** La cible d'un Relais ; `0` pour les verbes qui n'en ont pas. */
  readonly targetId: number;
}
```

- [ ] **Étape 1 : écrire les constantes de réglage**

`shared/abilities.ts` :

```ts
import { TICK_HZ } from './constants';
import type { VerbKind } from './classes';

/**
 * Les identifiants de verbe sur le fil.
 *
 * ⚠️ **Nombres, pas chaines, et l'ordre est fige** : `ABILITY_USED` les porte
 * en `u8`. Ajouter un verbe se fait a la FIN.
 */
export const VERB_IDS: Readonly<Record<VerbKind, number>> = Object.freeze({
  amorce: 0,
  rempart: 1,
  appat: 2,
  relais: 3,
});

/**
 * Recharge de chaque verbe, en ticks.
 *
 * ⚠️ **Reglages d'equilibrage, a confronter au playtest** (§11 de la spec).
 * Ils sont ici, nommes et en un seul endroit, pour qu'une partie puisse les
 * bouger sans fouiller le code. **Aucun test ne doit les coder en dur** : ils
 * se lisent d'ici.
 */
export const ABILITY_COOLDOWN_TICKS: Readonly<Record<VerbKind, number>> = Object.freeze({
  amorce: 6 * TICK_HZ,
  rempart: 12 * TICK_HZ,
  appat: 15 * TICK_HZ,
  relais: 10 * TICK_HZ,
});

/** Rayon de la zone d'Amorce et de Rempart, en pixels monde. */
export const ABILITY_ZONE_RADIUS = 160;

/** Duree de vie d'un leurre, en ticks. */
export const DECOY_LIFETIME_TICKS = 5 * TICK_HZ;

/** Portee d'un Relais : au-dela, l'allie est hors d'atteinte. */
export const RELAIS_RANGE = 1800;

/** Duree d'intangibilite offerte par le trait `relaisIntangible`, en ticks. */
export const RELAIS_INTANGIBLE_TICKS = Math.round(0.5 * TICK_HZ);

/**
 * Reduction de degats offerte par une zone de Rempart.
 *
 * ⚠️ **Elle se combine avec l'armure du compte par le MAXIMUM, jamais par une
 * somme** (§6.2 de la spec). La boutique vend `Armure` sur cinq paliers : une
 * somme ferait de « cinq paliers plus un Rempart » une quasi-immunite, et
 * l'abus se paierait en or donc se verrait mal.
 */
export const REMPART_ARMOR = 0.25;

/** Distance en deca de laquelle un allie est « adjacent », pour le trait `remparteAllie`. */
export const ADJACENT_RANGE = 120;
```

`shared/abilities.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { ABILITY_COOLDOWN_TICKS, VERB_IDS } from './abilities';
import { CLASSES } from './classes';

describe('etape 8 tache 3 : les reglages des verbes', () => {
  it('chaque verbe du catalogue a un identifiant ET une recharge', () => {
    for (const c of CLASSES) {
      expect(VERB_IDS[c.verb], c.verb).toBeTypeOf('number');
      expect(ABILITY_COOLDOWN_TICKS[c.verb], c.verb).toBeGreaterThan(0);
    }
  });

  it('les identifiants de verbe sont deux a deux distincts', () => {
    const ids = Object.values(VERB_IDS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('aucune recharge n est nulle — un verbe gratuit se spammerait a 30 Hz', () => {
    for (const [verbe, ticks] of Object.entries(ABILITY_COOLDOWN_TICKS)) {
      expect(ticks, verbe).toBeGreaterThan(1);
    }
  });
});
```

- [ ] **Étape 2 : écrire les tests du socle qui échouent**

Dans `back/src/room.test.ts` :

```ts
describe('etape 8 tache 3 : le socle du verbe', () => {
  it('un verbe demande est accepte UNE fois, puis refuse jusqu a la recharge', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0); // Amorce
    const recharge = ABILITY_COOLDOWN_TICKS.amorce;

    expect(room.useAbility(1, 1, 0)).not.toBeNull();
    expect(room.useAbility(1, 1, 0)).toBeNull();

    for (let t = 0; t < recharge - 1; t++) {
      room.step();
    }
    expect(room.useAbility(1, 1, 0)).toBeNull();
    room.step();
    expect(room.useAbility(1, 1, 0)).not.toBeNull();
  });

  /** Review Focus n°3 : un spam a 30 Hz ne doit laisser passer qu'un usage. */
  it('un spam de cent demandes dans le meme tick n en laisse passer qu une', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    let acceptes = 0;
    for (let i = 0; i < 100; i++) {
      if (room.useAbility(1, 1, 0)) {
        acceptes++;
      }
    }
    expect(acceptes).toBe(1);
  });

  /** Review Focus n°2 : un joueur mort n a pas de verbe. */
  it('un joueur mort est refuse en silence', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    tue(room, 1);
    expect(room.useAbility(1, 1, 0)).toBeNull();
  });

  it('un joueur inconnu est refuse en silence', () => {
    const room = new Room();
    expect(room.useAbility(42, 1, 0)).toBeNull();
  });

  it('l annonce porte le verbe de la CLASSE du joueur, pas un verbe choisi par lui', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 2); // Appat
    expect(room.useAbility(1, 1, 0)?.verb).toBe(VERB_IDS.appat);
  });
});
```

⚠️ **`tue(room, 1)` doit exister dans ce fichier** ou être écrit : cherche l'utilitaire déjà employé
par les tests de mort de `room.test.ts` et réemploie-le. N'en écris un nouveau que si aucun
n'existe, et dis-le au rapport.

- [ ] **Étape 3 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run src/room.test.ts ../shared/abilities.test.ts
```

Attendu : ÉCHEC — `room.useAbility` n'existe pas, et `join` ne prend pas de quatrième argument.

- [ ] **Étape 4 : le protocole**

Dans `shared/protocol.ts`, ajoute aux `MSG` : `ABILITY: 24`, `ABILITY_USED: 25`.

```ts
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

/**
 * S -> C : le salon ANNONCE un verbe accepte, 13 octets.
 *
 * `type u8 · tick u32 · playerId u8 · verb u8 · x i16 · y i16 · targetId u8`
 *
 * ⚠️ **L'annonce, jamais l'effet.** Les deux cotes derivent l'effet de ces
 * parametres et de ce tick — le patron de `BOSS_CHARGE`, dont la charge deplace
 * le boss de 2700 px en gardant une derive de 0,000 px (scenario 11c de
 * `shared/horde.replication.test.ts`).
 */
export const ABILITY_USED_BYTES = 13;

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
  v.setUint8(12, 0); // reserve : garde la largeur paire, voir le docbloc
  return buf;
}
```

⚠️ **Additionne : 1 + 4 + 1 + 1 + 2 + 2 + 1 = 12, et la largeur déclarée est 13.** L'octet 12 est
une réserve explicite. **Si tu préfères 12 sans réserve, fais-le et corrige la constante** — mais
alors épingle 12 en nombre nu dans le test, et dis-le au rapport. Ce qui est interdit, c'est qu'une
largeur déclarée ne corresponde pas à l'addition.

Ajoute les deux cas au `decode` existant, symétriques, avec le refus d'une trame tronquée.

- [ ] **Étape 5 : `Room` arbitre**

Dans `back/src/room.ts`, `PlayerState` gagne :

```ts
  /** La classe choisie au salon. Posee une fois a `join`, jamais mutee ensuite. */
  readonly classId: number;
  /** Tick du dernier verbe ACCEPTE. `-Infinity` : jamais utilise. */
  lastAbilityTick: number;
```

`join` gagne un quatrième paramètre `classId = DEFAULT_CLASS_ID`, et initialise
`lastAbilityTick: Number.NEGATIVE_INFINITY` — même tissu que `lastFireTick`, qui est déjà un
`Float64Array` rempli de `-Infinity`.

```ts
  /**
   * Arbitre une demande de verbe. Rend l'annonce a diffuser, ou `null`.
   *
   * ⚠️ **Le refus est SILENCIEUX** — meme discipline que `setDraftToken` et
   * `setVote` : un geste refuse n'est simplement pas enregistre, et le client le
   * verra a la prochaine diffusion. Aucun client ne decide de quoi que ce soit.
   */
  useAbility(playerId: number, aimX: number, aimY: number): AbilityUsed | null {
    const p = this.#players.get(playerId);
    if (!p || p.hp <= 0) {
      return null;
    }
    const classe = classOf(p.classId);
    if (!classe) {
      return null;
    }
    const recharge = ABILITY_COOLDOWN_TICKS[classe.verb];
    if (this.#tick - p.lastAbilityTick < recharge) {
      return null;
    }
    p.lastAbilityTick = this.#tick;
    return this.#applyAbility(p, classe.verb, aimX, aimY);
  }
```

`#applyAbility` rend l'annonce et, à cette tâche, **n'applique encore aucun effet** : elle rend
`{ tick: this.#tick, playerId: p.id, verb: VERB_IDS[verb], x, y, targetId: 0 }`. Les tâches 4 à 7
y branchent un effet chacune.

- [ ] **Étape 6 : le serveur relaie**

Dans `back/src/server.ts`, à côté de `MSG.INPUT` :

```ts
    if (msg.type === MSG.ABILITY) {
      const annonce = this.room.useAbility(id, msg.aimX, msg.aimY);
      if (annonce) {
        this.#broadcast(
          encodeAbilityUsed(
            annonce.tick,
            annonce.playerId,
            annonce.verb,
            annonce.x,
            annonce.y,
            annonce.targetId,
          ),
        );
      }
      return;
    }
```

⚠️ **Rien n'est diffusé sur un refus.** Pas de message d'erreur, pas d'accusé : le client sait que
sa demande n'a pas abouti parce qu'aucune annonce n'arrive.

- [ ] **Étape 7 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/room.test.ts ../shared/abilities.test.ts ../shared/protocol.test.ts
cd .. && npm run lint && npm run typecheck
git add shared/abilities.ts shared/abilities.test.ts shared/protocol.ts back/src/room.ts back/src/room.test.ts back/src/server.ts
git commit -m "feat: le socle du verbe, arbitre par le salon et annonce

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 4 : Amorce — poser l'élément, et le résidu partout

**Files :**
- Modify: `back/src/room.ts` (`#applyAbility`, branche `amorce`)
- Modify: `front/src/net/client.ts` (le miroir dérive la même zone)
- Modify: `back/src/room.test.ts`
- Modify: `front/src/net/client.test.ts`

**Interfaces :**
- Consumes: `ABILITY_ZONE_RADIUS` (tâche 3), `ZoneField#spawn`, `packZoneKind`.
- Produces: rien de neuf — une branche de `#applyAbility`.

**Ce que le verbe fait :** pose au point visé une zone de l'**élément de l'arme principale du
joueur**, à **réaction nulle**, sans dégâts.

**L'appui vérifié :** `ZoneField#spawn(kind: number, x: number, y: number, playerId: number, tick: number): number`
existe (`shared/zones.ts:201`), et `packZoneKind(element, reaction)` empaquette l'élément dans les
bits 0-2 et la réaction dans les bits 3-6 (`shared/protocol.ts:1135`). Une zone de réaction nulle
est donc `packZoneKind(element, 0)`, et `ZoneField` documente déjà ce cas pour « l'appelant qui ne
connaît encore aucun type de réaction ».

- [ ] **Étape 1 : écrire les tests qui échouent**

Dans `back/src/room.test.ts` :

```ts
describe('etape 8 tache 4 : Amorce', () => {
  it('ANNONCE une zone de l element de l arme du joueur, sans degats', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0); // Amorce
    room.drainZones(); // vide ce qui precede

    const annonce = room.useAbility(1, 300, 0);
    expect(annonce).not.toBeNull();

    // ⚠️ On lit l'ANNONCE (`drainZones`), pas l'etat interne : `#zones` est
    // prive, et c'est l'annonce que le client recoit. Eprouver l'etat interne
    // laisserait passer une zone posee mais jamais diffusee.
    const annoncees = room.drainZones();
    expect(annoncees.length).toBe(1);
    const z = annoncees[0];
    if (!z) {
      throw new Error('aucune zone annoncee');
    }
    expect(z.by).toBe(1);
    // L'element est celui de l'arme, LU de sa source — jamais code en dur.
    expect(zoneElement(z.kind)).toBe(elementOf(room.principalWeaponOf(1)));
    // Reaction NULLE : elle ne brule pas.
    expect(zoneReaction(z.kind)).toBe(0);
    expect(zoneBurnPerTick(z.kind)).toBe(0);
  });

  /** La paire discriminante : il agit ici, et il n'agit pas la. */
  it('une classe qui n est PAS Amorce n annonce aucune zone', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 1); // Rempart
    room.drainZones();
    room.useAbility(1, 300, 0);
    expect(room.drainZones().length).toBe(0);
  });

  it('la zone est annoncee au point VISE, pas a la position du joueur', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0);
    place(room, 1, 0, 0);
    room.drainZones();
    room.useAbility(1, 300, 400);
    const z = room.drainZones()[0];
    expect([z?.x, z?.y]).toEqual([300, 400]);
  });
});
```

⚠️ **Vérifie trois noms avant d'écrire, et emploie les vrais.** `zoneElement` est exporté de
`shared/protocol.ts` ; le « dégât par tick qu'une zone infligé d'elle-même » est dans
`shared/reactions.ts` vers la ligne 916 — **relis son nom exact**. Et `room.principalWeaponOf(1)`
n'existe probablement pas : trouve comment `Room` lit l'arme principale d'un joueur (voir le site de
tir, `room.ts` vers 1600) et **ajoute un accesseur de lecture étroit** à côté de `maxHpOf` si rien
ne convient. **N'invente aucun accesseur sans le déclarer dans les Interfaces de cette tâche.**

⚠️ **Et `ZoneEvent` porte `by`, pas `playerId`** (`back/src/room.ts:165` :
`{ kind, x, y, bornTick, by }`). Un nom supposé ici ne compilerait pas.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run src/room.test.ts
```

Attendu : ÉCHEC — aucune zone n'est posée, `zones.count` est inchangé.

- [ ] **Étape 3 : implémenter la branche**

Dans `#applyAbility` de `back/src/room.ts` :

```ts
      case 'amorce': {
        // L'element vient de l'arme PRINCIPALE du joueur, jamais de la classe :
        // une classe ne porte jamais d'element (§3 de la spec).
        const element = elementOf(this.#principalWeaponOf(p));
        this.#spawnZone(packZoneKind(element, 0), x, y, p.id);
        return { tick: this.#tick, playerId: p.id, verb: VERB_IDS.amorce, x, y, targetId: 0 };
      }
```

⚠️ **Passe par le chemin qui ANNONCE, pas par `#zones.spawn` nu.** Une zone posée sans être poussée
dans `#pendingZones` ne serait jamais diffusée : le serveur l'aurait, le client non, et la
divergence serait invisible aux tests du serveur seul. Trouve le site existant qui fait les deux —
celui qu'une réaction emprunte déjà — et emprunte-le.

⚠️ **Et tranche la question que la spec a laissée ouverte (§11) : combien de zones un Amorce peut-il
entretenir à la fois ?** Rien ne limite aujourd'hui les zones simultanées d'un joueur, parce
qu'aucun joueur n'en posait volontairement. Avec une recharge de `ABILITY_COOLDOWN_TICKS.amorce` et
une durée de vie de `ZONE_LIFETIME_TICKS`, **calcule le nombre maximal** de zones qu'un seul Amorce
peut tenir vivantes, et compare-le à la capacité de `ZoneField` — qui compte déjà ses
`truncatedZones`. Si le calcul dépasse la capacité, **dis-le avant d'implémenter** : une troncature
silencieuse de zones serait une divergence, pas un détail de rendu.

- [ ] **Étape 4 : le trait `residuPartout`**

Le §6.4 veut que **trois réactions sur quinze** laissent un effet au sol, et c'est le cas. Le trait
étend ce comportement **aux quinze, dans les zones de ce joueur seulement**.

Trouve le site qui décide si une réaction laisse une zone (il dérive de la table des réactions, pas
d'un `if` au point d'impact) et ajoute la condition : si la réaction a été déclenchée dans une zone
dont `playerId` est un joueur de classe Amorce, elle laisse son résidu même quand sa table dit non.

```ts
  /**
   * Le trait `residuPartout` : dans les zones d'un Amorce, les quinze reactions
   * laissent un residu, pas seulement les trois du §6.4.
   *
   * ⚠️ **La condition porte sur le POSEUR de la zone, pas sur l'auteur de la
   * reaction.** Le trait recompense d'avoir prepare le terrain, et il fonctionne
   * donc quand un ALLIE declenche la reaction dans votre zone — c'est ce qui le
   * rend tourne vers l'equipe plutot que vers soi.
   */
```

- [ ] **Étape 5 : le test du trait**

```ts
  it('le trait residuPartout fait laisser un residu a une reaction qui n en laisse pas', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0); // Amorce
    room.join(2, undefined, undefined, 1); // Rempart : son allie declenche

    const sansResidu = REACTIONS.find((r) => r.zoneLifetimeTicks === 0);
    if (!sansResidu) {
      throw new Error('aucune reaction sans residu dans la table');
    }

    const avant = room.zoneCount;
    declencheDansLaZoneDe(room, 1, 2, sansResidu); // allie 2, zone du joueur 1
    expect(room.zoneCount).toBeGreaterThan(avant);
  });

  it('sans le trait, la meme reaction ne laisse rien', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 1); // Rempart pose la zone : pas de trait
    room.join(2, undefined, undefined, 1);

    const sansResidu = REACTIONS.find((r) => r.zoneLifetimeTicks === 0);
    if (!sansResidu) {
      throw new Error('aucune reaction sans residu dans la table');
    }

    const avant = room.zoneCount;
    declencheDansLaZoneDe(room, 1, 2, sansResidu);
    expect(room.zoneCount).toBe(avant);
  });
```

⚠️ **Si aucune réaction de la table n'a `zoneLifetimeTicks === 0`**, ce trait n'a aucun effet
observable et c'est un **mécanisme mort** — le défaut dont l'étape 5c a documenté quatre cas.
**Mesure-le avant d'implémenter** : compte les réactions à résidu dans `shared/reactions.ts`. Si les
quinze en laissent déjà un, **arrête-toi et dis-le** : le trait d'Amorce doit être redessiné, pas
contourné.

- [ ] **Étape 6 : le miroir client**

Dans `front/src/net/client.ts`, à la réception de `ABILITY_USED` avec `verb === VERB_IDS.amorce` :
la même ligne `zones.spawn(packZoneKind(element, 0), x, y, playerId, tick)`, avec l'élément lu de
l'arme de **ce** joueur.

⚠️ **Mutation exigée :** change l'élément du côté client (prends celui du joueur local au lieu de
celui du lanceur) et montre que le livrable de la tâche 9 rougit sur la dérive. Si rien ne rougit,
**dis-le** — ça voudrait dire que la zone n'est pas éprouvée en réplication.

- [ ] **Étape 7 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/room.test.ts
cd ../front && npx vitest run
cd .. && npm run lint && npm run typecheck
git add back/src/room.ts back/src/room.test.ts front/src/net/client.ts front/src/net/client.test.ts
git commit -m "feat: Amorce pose l element de son arme, et son residu partout

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 5 : Rempart — la zone qui protège, et l'allié adjacent

**Files :**
- Modify: `back/src/room.ts` (`#applyAbility`, branche `rempart` ; l'alimentation de `player.armor`)
- Modify: `back/src/combat.ts` (rien de la formule — seulement la source de `player.armor`)
- Modify: `back/src/room.test.ts`

**Interfaces :**
- Consumes: `ABILITY_ZONE_RADIUS` (tâche 3).
- Produces: `Room#armorOf(playerId: number): number` — accesseur de lecture, à côté de `maxHpOf`.

**L'appui vérifié :** `resolveContact` (`back/src/combat.ts`) porte **le site unique où un joueur
perd des PV** :

```ts
player.hp = Math.max(0, player.hp - CONTACT_DAMAGE * (1 - (player.armor ?? 0)));
```

Et `player.armor` est déjà alimenté à `join` depuis `compte?.bonuses.armor` — la boutique vend
`Armure` (`'armor'`, 5 paliers). **Le point d'accroche existe ; il n'y a aucune seconde formule de
dégâts à écrire.**

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 8 tache 5 : Rempart', () => {
  it('un allie dans la zone encaisse moins, un allie dehors encaisse autant', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 1); // Rempart
    room.join(2, undefined, undefined, 0); // l'allie protege
    room.join(3, undefined, undefined, 0); // le temoin, hors zone

    place(room, 2, 0, 0);
    place(room, 3, ABILITY_ZONE_RADIUS * 4, 0);
    room.useAbility(1, 0, 0);

    expect(room.armorOf(2)).toBeGreaterThan(0);
    expect(room.armorOf(3)).toBe(0);
  });

  /**
   * ⚠️ **MAXIMUM, jamais une somme** — §6.2 de la spec. La boutique vend
   * `Armure` sur cinq paliers ; une somme ferait de « cinq paliers plus un
   * Rempart » une quasi-immunite, et l'abus se paierait en or donc se verrait
   * mal.
   */
  it('l armure du compte et celle du Rempart se combinent par le MAXIMUM', () => {
    const armure = SHOP_ITEMS.find((i) => i.bonusKind === 'armor');
    if (!armure) {
      throw new Error('la boutique ne vend plus d armure');
    }
    const achetee = armure.perLevel * armure.levels;

    const room = new Room();
    room.join(1, undefined, undefined, 1);
    room.join(2, { bonuses: { ...BONUS_ZERO, armor: achetee } }, undefined, 0);
    place(room, 2, 0, 0);
    room.useAbility(1, 0, 0);

    const rempart = REMPART_ARMOR;
    expect(room.armorOf(2)).toBe(Math.max(achetee, rempart));
    // Et surtout : PAS la somme.
    expect(room.armorOf(2)).toBeLessThan(achetee + rempart);
  });

  it('le trait remparteAllie etend la protection a l allie adjacent, hors zone', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 1); // Rempart : il a le trait
    room.join(2, undefined, undefined, 0);

    // L'allie est HORS de la zone, mais adjacent au Rempart lui-meme.
    place(room, 1, 0, 0);
    place(room, 2, ABILITY_ZONE_RADIUS * 3, 0);
    place(room, 1, ABILITY_ZONE_RADIUS * 3 + ADJACENT_RANGE / 2, 0);
    room.useAbility(1, 0, 0); // la zone est posee LOIN des deux

    expect(room.armorOf(2)).toBeGreaterThan(0);
  });

  it('sans le trait, le meme allie adjacent n est pas protege', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 0); // Amorce : pas le trait
    room.join(2, undefined, undefined, 0);
    place(room, 1, 0, 0);
    place(room, 2, ADJACENT_RANGE / 2, 0);
    room.useAbility(1, 10_000, 10_000);
    expect(room.armorOf(2)).toBe(0);
  });
});
```

⚠️ **`REMPART_ARMOR` et `ADJACENT_RANGE` appartiennent à `shared/abilities.ts`** — ajoute-les y, pas
en dur dans le test. `place(room, id, x, y)` doit exister dans `room.test.ts` ; cherche-le avant
d'en écrire un.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run src/room.test.ts
```

Attendu : ÉCHEC — `room.armorOf` n'existe pas.

- [ ] **Étape 3 : implémenter**

Branche `rempart` de `#applyAbility` : pose une zone de protection (un champ propre, **pas** un
`ZoneField` élémentaire — une zone de Rempart ne marque aucun élément et ne doit jamais participer
à une réaction).

Puis, au point où `player.armor` est lu par `resolveContact`, l'alimenter ainsi :

```ts
  /**
   * L'armure effective d'un joueur : le MAXIMUM de celle de son compte et de
   * toute protection de Rempart qui le couvre.
   *
   * ⚠️ **Un MAXIMUM, jamais une somme ni un produit** — la meme regle que
   * `ZoneField` applique deja entre deux zones, et pour la raison que son
   * docbloc donne : deux flaques qui se recouvrent « ne doublent pas : elles
   * donnent la plus forte ». Voir §6.2 de la spec.
   */
  armorOf(playerId: number): number {
    const p = this.#players.get(playerId);
    if (!p) {
      return 0;
    }
    return Math.max(p.accountBonuses.armor, this.#remparteCouvre(p) ? REMPART_ARMOR : 0);
  }
```

⚠️ **`resolveContact` doit lire cette valeur, pas `accountBonuses.armor`.** Sinon le Rempart
n'existe que dans l'accesseur, et c'est un **mécanisme mort**. Le test de la première étape le
prouve par les PV, pas seulement par `armorOf` — **ajoute cette assertion si elle manque**.

- [ ] **Étape 4 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/room.test.ts src/combat.test.ts
cd .. && npm run lint && npm run typecheck
git add back/src/room.ts back/src/room.test.ts back/src/combat.ts shared/abilities.ts
git commit -m "feat: Rempart protege la zone et l allie adjacent, par le maximum

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 6 : Appât — le leurre prend la place de son lanceur

**C'est la tâche la plus risquée de l'étape : elle touche la colonne vertébrale du projet.**

**Files :**
- Create: `shared/decoys.ts`
- Create: `shared/decoys.test.ts`
- Modify: `back/src/room.ts` (branche `appat`, et l'entrée du champ)
- Modify: `front/src/net/client.ts` (**les deux** sites d'entrée du champ)
- Modify: `shared/horde.replication.test.ts`

**Interfaces :**
- Consumes: `DECOY_LIFETIME_TICKS` (tâche 3).
- Produces: `interface Decoy { readonly playerId: number; readonly x: number; readonly y: number; readonly bornTick: number }` ;
  `substituteDecoys(ids: readonly number[], x: readonly number[], y: readonly number[], decoys: readonly Decoy[], tick: number): { x: number[]; y: number[] }`.

⚠️ **La signature porte `ids`, et c'est le point le plus important de la tâche.** `seen.x` est rempli
par l'**ordre d'itération** de `#players.values()` (`back/src/room.ts` vers 1003) — pas par
identifiant. L'indice d'un joueur **change donc quand un autre se déconnecte**. Un leurre qui
retiendrait un indice serait désaligné au premier départ, et **un cran de décalage réassigne toute
la horde**. Le leurre retient donc un `playerId`, et la substitution résout l'indice elle-même, à
partir du même tableau d'identifiants que les deux côtés possèdent déjà dans le même ordre.

### Pourquoi cette forme, et pas une autre

Le serveur alimente le champ de flux ainsi (`back/src/room.ts` vers la ligne 1014) :

```ts
      const seen = this.#history.delayed(this.#tick);
      if (seen) {
        this.#fieldInputTick = seen.tick;
        for (let f = 0; f < seen.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(seen.x[f] ?? 0, seen.y[f] ?? 0);
        }
        this.horde.retarget(seen.x, seen.y);
      }
```

Trois faits décident de tout :

1. **`seen` est la source retardée, identique des deux côtés par construction**
   (`FIELD_INPUT_DELAY_TICKS = 3`, lue de `PlayerHistory`). Le serveur s'impose le retard qu'il
   infligera au client.
2. **Il y a un champ de flux PAR JOUEUR**, et le banc de l'étape 1 a mesuré le budget à **quatre
   champs** (~117 000 cellules par champ pour 11 ms). **Un cinquième champ dépasserait la mesure.**
3. `retarget(playerX, playerY)` assigne chaque entité **au plus proche** de ces points.

⚠️ **D'où la seule forme viable : le leurre REMPLACE son lanceur dans l'entrée du champ**, pour la
durée de sa vie. Zéro champ de plus, zéro coût de plus, et le sens de jeu est juste — les monstres
qui vous poursuivaient marchent vers le leurre.

⚠️ **Et la substitution doit vivre dans `shared/`, appelée par les deux côtés.** Le client fait le
même calcul à **deux endroits** (`front/src/net/client.ts`, vers 1967 et 2578). Trois copies d'une
règle de substitution divergeraient, et **une divergence d'un cran sur `seen.x` ferait dériver toute
la horde**. Une seule fonction pure, trois appelants.

- [ ] **Étape 1 : écrire les tests de la substitution**

`shared/decoys.test.ts` :

```ts
import { describe, expect, it } from 'vitest';

import { DECOY_LIFETIME_TICKS } from './abilities';
import { type Decoy, substituteDecoys } from './decoys';

describe('etape 8 tache 6 : la substitution du leurre', () => {
  it('remplace la position de son lanceur, et laisse les autres intactes', () => {
    const d: Decoy = { playerId: 2, x: 500, y: 600, bornTick: 10 };
    const r = substituteDecoys([1, 2, 3], [0, 100, 200], [0, 100, 200], [d], 10);
    expect(r.x).toEqual([0, 500, 200]);
    expect(r.y).toEqual([0, 600, 200]);
  });

  /**
   * ⚠️ **LE test de cette tache.** `seen.x` est indexe par l'ordre d'iteration
   * des joueurs, pas par identifiant : quand un joueur part, les indices de
   * ceux qui restent BOUGENT. Un leurre qui retiendrait un indice suivrait le
   * mauvais joueur, et un cran de decalage reassigne TOUTE la horde.
   */
  it('suit son lanceur quand les indices bougent, parce qu il retient un ID', () => {
    const d: Decoy = { playerId: 3, x: 500, y: 600, bornTick: 0 };
    // Le joueur 1 est parti : 3 n'est plus au deuxieme rang mais au premier.
    const r = substituteDecoys([3, 4], [10, 20], [10, 20], [d], 0);
    expect(r.x).toEqual([500, 20]);
    expect(r.y).toEqual([600, 20]);
  });

  it('n allonge ni ne raccourcit les tableaux', () => {
    const d: Decoy = { playerId: 2, x: 500, y: 600, bornTick: 0 };
    const r = substituteDecoys([1, 2, 3, 4], [0, 1, 2, 3], [0, 1, 2, 3], [d], 0);
    expect(r.x.length).toBe(4);
    expect(r.y.length).toBe(4);
  });

  it('un leurre expire cesse de substituer, exactement a sa date', () => {
    const d: Decoy = { playerId: 1, x: 500, y: 600, bornTick: 0 };
    const dernier = DECOY_LIFETIME_TICKS - 1;
    expect(substituteDecoys([1], [0], [0], [d], dernier).x).toEqual([500]);
    expect(substituteDecoys([1], [0], [0], [d], DECOY_LIFETIME_TICKS).x).toEqual([0]);
  });

  /** Review Focus n°5 : un leurre dont le lanceur est mort ou deconnecte. */
  it('un leurre dont le lanceur n est plus dans la salle ne corrompt rien', () => {
    const d: Decoy = { playerId: 7, x: 500, y: 600, bornTick: 0 };
    const r = substituteDecoys([1, 2], [0, 1], [0, 1], [d], 0);
    expect(r.x).toEqual([0, 1]);
    expect(r.y).toEqual([0, 1]);
  });

  it('sans aucun leurre, rend exactement ce qu on lui donne', () => {
    const r = substituteDecoys([1, 2], [3, 4], [5, 6], [], 0);
    expect(r.x).toEqual([3, 4]);
    expect(r.y).toEqual([5, 6]);
  });
});
```

⚠️ **`Room` doit désormais construire un tableau d'identifiants à côté de `xs`/`ys`.** Le site est
`back/src/room.ts` vers la ligne 1003 :

```ts
    const ids: number[] = [];
    const xs: number[] = [];
    const ys: number[] = [];
    for (const p of this.#players.values()) {
      ids.push(p.id);
      xs.push(Math.round(p.x));
      ys.push(Math.round(p.y));
    }
```

⚠️ **Et `PlayerHistory` doit retenir ces identifiants avec les positions**, sinon le client n'aura
pas le même tableau. Lis `PlayerPositions` (`shared/player-history.ts:20` : `{ tick, x, y }`) et
**ajoute-y `ids`**, en élargissant le stockage comme `#x`/`#y` le sont déjà
(`Float32Array(DEPTH * MAX_PLAYERS)`). **Si cette extension s'avère plus lourde qu'elle n'en a
l'air, arrête-toi et dis-le** : c'est le cœur de la réplication, et un historique à moitié élargi
serait pire que pas d'Appât du tout.

⚠️ **Le serveur s'impose l'arrondi comme il s'impose le retard** : `xs` porte `Math.round(p.x)`, et
son docbloc explique pourquoi — sans l'arrondi, les deux côtés enracineraient leur BFS dans des
cellules différentes une fois par cellule et par axe. **Les positions d'un leurre s'arrondissent de
la même façon**, et pour la même raison.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run ../shared/decoys.test.ts
```

Attendu : ÉCHEC — `Cannot find module './decoys'`.

- [ ] **Étape 3 : écrire la substitution**

`shared/decoys.ts` — une fonction **pure**, aucun état, aucun effet.

```ts
import { DECOY_LIFETIME_TICKS } from './abilities';

/**
 * Un leurre : un point qui compte comme cible, a la place de son lanceur.
 *
 * ⚠️ **Ce n'est PAS un deplacement de monstres**, et la distinction decide du
 * risque de cette etape. Le champ de flux est alimente par des positions
 * RETARDEES (`FIELD_INPUT_DELAY_TICKS`), identiques des deux cotes par
 * construction. Un leurre est une entree de ce meme tableau — annonce une fois
 * avec son tick, derive ensuite. Rien ne bouge qui ne bougeait pas.
 */
export interface Decoy {
  /**
   * ⚠️ **L'IDENTIFIANT du lanceur, jamais son indice.** `seen.x` est rempli par
   * l'ordre d'iteration des joueurs : les indices BOUGENT quand quelqu'un part.
   * Un leurre qui retiendrait un indice suivrait le mauvais joueur, et un cran
   * de decalage reassigne toute la horde — une derive qui ne se rattrape pas,
   * puisqu'elle s'accumule a chaque pas.
   */
  readonly playerId: number;
  readonly x: number;
  readonly y: number;
  readonly bornTick: number;
}

/**
 * Rend les positions d'entree du champ, leurres substitues.
 *
 * ⚠️ **La longueur des tableaux ne change JAMAIS.** Un cran de decalage sur
 * `seen.x` reassignerait toute la horde a d'autres cibles, et la derive ne se
 * rattrape pas : elle s'accumule a chaque pas. C'est pourquoi un leurre dont
 * le `slot` depasse les tableaux est simplement ignore, jamais pousse a la fin.
 *
 * ⚠️ **Appelee par les TROIS sites** — `Room#step` et les deux du miroir client.
 * Trois copies de cette regle divergeraient ; une fonction pure ne peut pas.
 */
export function substituteDecoys(
  ids: readonly number[],
  x: readonly number[],
  y: readonly number[],
  decoys: readonly Decoy[],
  tick: number,
): { x: number[]; y: number[] } {
  const sx = [...x];
  const sy = [...y];
  for (const d of decoys) {
    if (tick - d.bornTick >= DECOY_LIFETIME_TICKS) {
      continue;
    }
    // L'indice se RESOUT ici, a partir du tableau d'identifiants que les deux
    // cotes possedent dans le meme ordre. Un lanceur absent (mort, deconnecte)
    // rend -1 : le leurre est ignore, jamais pousse a la fin.
    const i = ids.indexOf(d.playerId);
    if (i < 0 || i >= sx.length) {
      continue;
    }
    sx[i] = d.x;
    sy[i] = d.y;
  }
  return { x: sx, y: sy };
}
```

- [ ] **Étape 4 : brancher les trois sites**

Dans `back/src/room.ts`, et **aux deux sites** de `front/src/net/client.ts` :

```ts
        const cible = substituteDecoys(seen.ids, seen.x, seen.y, this.#decoys, seen.tick);
        for (let f = 0; f < cible.x.length && f < this.#fields.length; f++) {
          this.#fields[f]?.update(cible.x[f] ?? 0, cible.y[f] ?? 0);
        }
        this.horde.retarget(cible.x, cible.y);
```

⚠️ **Les trois sites passent `seen.tick`, jamais `this.#tick`.** C'est le tick **retardé**, celui
dont proviennent les positions — et c'est lui que les deux côtés partagent. Passer le tick courant
d'un côté et le tick retardé de l'autre ferait expirer les leurres à trois ticks d'écart, et la
dérive serait **silencieuse jusqu'à la fin de la run**.

**Preuve exigée, appliquée et non raisonnée :** passe `this.#tick` à un seul des trois sites et
montre que le scénario de l'étape 5 rougit.

- [ ] **Étape 5 : le livrable de réplication, et c'est l'assertion qui décide**

Dans `shared/horde.replication.test.ts`, un scénario de plus, sur le modèle de `11c` (la charge du
boss) :

```ts
  it('scenario AP (appat) : la horde converge identiquement malgre trois leurres', () => {
    // Trois leurres poses a des ticks differents, dont un qui expire pendant
    // que les deux autres vivent, et un pose au-dela de ROLLBACK_DEPTH_TICKS.
    const derive = rejoueAvecLeurres([40, 95, 150]);
    process.stdout.write(`scenario AP : derive maximale ${derive.toFixed(3)} px\n`);
    expect(derive).toBe(0);
  });
```

⚠️ **`toBe(0)`, pas une tolérance.** Le contrat du projet est **0,000 px**, tenu depuis l'étape 2 à
travers neuf familles de scénarios. Une tolérance ici serait le premier assouplissement du contrat,
et il ne se verrait jamais.

**Preuve exigée, appliquée et non raisonnée :** change `this.#tick` en `seen.tick` **d'un seul côté**
et montre que ce scénario rougit. Si la dérive reste à 0, **dis-le** : ça voudrait dire que le
scénario n'éprouve pas la substitution.

- [ ] **Étape 6 : le trait `leurreElementaire`**

Le leurre d'un Appât porte l'élément de son arme : il pose, à sa naissance, une zone de réaction
nulle de cet élément — la même ligne que la tâche 4. Le leurre devient donc un poseur passif en plus
d'un aimant à monstres.

Test de la paire discriminante : un Appât pose une zone avec son leurre ; **une autre classe n'en
pose aucune** (et ne peut d'ailleurs pas poser de leurre).

- [ ] **Étape 7 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run ../shared/decoys.test.ts ../shared/horde.replication.test.ts src/room.test.ts
cd ../front && npx vitest run
cd .. && npm run lint && npm run typecheck
git add shared/decoys.ts shared/decoys.test.ts shared/horde.replication.test.ts back/src/room.ts front/src/net/client.ts
git commit -m "feat: l Appat plante un leurre qui prend la place de son lanceur

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

⚠️ `shared/horde.replication.test.ts` porte un `vi.setConfig({ testTimeout: 300_000 })` local, parce
que cinq de ses scénarios dépassent 60 s (jusqu'à 104,3 s). **Ton scénario s'ajoute à ce budget** :
mesure son coût et, s'il fait franchir le plafond, relève-le **en déclarant la mesure**, comme les
deux relèvements précédents l'ont fait.

---

## Tâche 7 : Relais — se téléporter, et rendre l'allié intangible

**Files :**
- Modify: `back/src/room.ts` (branche `relais`)
- Modify: `front/src/net/client.ts` (le miroir recale sa prédiction)
- Modify: `back/src/room.test.ts`
- Modify: `front/src/net/prediction.test.ts`

**Interfaces :**
- Consumes: `RELAIS_RANGE`, `RELAIS_INTANGIBLE_TICKS` (tâche 3).
- Produces: rien de neuf — l'annonce porte déjà `targetId`.

**Ce que le verbe fait :** téléporte le lanceur sur l'**allié vivant le plus proche du point visé**,
dans la limite de `RELAIS_RANGE`.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 8 tache 7 : Relais', () => {
  it('teleporte le lanceur sur l allie vise, et l annonce porte sa cible', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 3); // Relais
    room.join(2, undefined, undefined, 0);
    place(room, 1, 0, 0);
    place(room, 2, 400, 300);

    const annonce = room.useAbility(1, 400, 300);
    expect(annonce?.targetId).toBe(2);
    expect(positionDe(room, 1)).toEqual(positionDe(room, 2));
  });

  /** Review Focus n°4 : vers soi-meme, et vers un allie disparu. */
  it('un Relais vers soi-meme est refuse en silence', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 3);
    place(room, 1, 0, 0);
    expect(room.useAbility(1, 0, 0)).toBeNull();
  });

  it('un Relais sans aucun allie vivant est refuse en silence', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 3);
    room.join(2, undefined, undefined, 0);
    tue(room, 2);
    expect(room.useAbility(1, 400, 300)).toBeNull();
  });

  it('un allie hors de portee est refuse en silence', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 3);
    room.join(2, undefined, undefined, 0);
    place(room, 1, 0, 0);
    place(room, 2, RELAIS_RANGE * 2, 0);
    expect(room.useAbility(1, RELAIS_RANGE * 2, 0)).toBeNull();
  });

  it('un refus ne consomme PAS la recharge', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 3);
    room.join(2, undefined, undefined, 0);
    place(room, 1, 0, 0);
    place(room, 2, 400, 0);

    expect(room.useAbility(1, 0, 0)).toBeNull(); // vers soi-meme
    expect(room.useAbility(1, 400, 0)).not.toBeNull(); // la vraie demande passe
  });

  it('le trait relaisIntangible rend l allie brievement intangible', () => {
    const room = new Room();
    room.join(1, undefined, undefined, 3); // Relais : il a le trait
    room.join(2, undefined, undefined, 0);
    place(room, 1, 0, 0);
    place(room, 2, 400, 0);
    room.useAbility(1, 400, 0);
    expect(room.intangibleTicksOf(2)).toBe(RELAIS_INTANGIBLE_TICKS);
  });
});
```

⚠️ **« Un refus ne consomme pas la recharge » est une propriété à part entière.** Le socle de la
tâche 3 pose `lastAbilityTick` **avant** de calculer l'effet : si l'effet échoue, la recharge est
déjà partie et le joueur est puni d'un verbe qu'il n'a pas eu. **Corrige l'ordre dans la tâche 3 si
ce test rougit pour cette raison**, et dis-le au rapport — c'est un défaut de mon plan, pas du tien.

- [ ] **Étape 2 : lancer pour vérifier que ça échoue**

```bash
cd back && npx vitest run src/room.test.ts
```

- [ ] **Étape 3 : implémenter**

La branche `relais` cherche l'allié **vivant** le plus proche du point visé, autre que soi, dans
`RELAIS_RANGE` ; si aucun, elle rend `null` **sans avoir posé la recharge**. Sinon elle déplace le
lanceur et, si sa classe porte le trait, pose `intangibleTicks` sur la cible.

⚠️ **`contactInvulnTicks` existe déjà sur `PlayerState`.** Vérifie s'il convient avant d'ajouter un
second compteur : deux compteurs d'invulnérabilité divergeraient, et le jour où ils divergent c'est
un test qui manque.

- [ ] **Étape 4 : le miroir recale sa prédiction**

À la réception de `ABILITY_USED` avec `verb === VERB_IDS.relais`, si le lanceur est le joueur local,
le client **recale** sa position prédite sur celle annoncée, au tick annoncé.

⚠️ **C'est le seul verbe à toucher la prédiction**, et le docbloc de `front/src/net/prediction.ts`
dit ce que coûte une prédiction qui dérive de l'autorité : *« le joueur voit une réconciliation
permanente, exactement le défaut que la prédiction existe pour éviter »*. Un Relais non recalé
donnerait une réconciliation d'un bout à l'autre de la carte.

Test : après l'annonce, la position prédite **égale** la position annoncée, sans passer par une
interpolation.

- [ ] **Étape 5 : lancer, lint, typecheck, commit**

```bash
cd back && npx vitest run src/room.test.ts
cd ../front && npx vitest run
cd .. && npm run lint && npm run typecheck
git add back/src/room.ts back/src/room.test.ts front/src/net/client.ts front/src/net/prediction.test.ts
git commit -m "feat: le Relais teleporte vers l allie, et le rend intangible

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 8 : le choix de classe à l'écran

**Files :**
- Modify: `front/src/ui/room.ts`
- Modify: `front/src/ui/room.test.ts`
- Modify: `front/index.html`

**Interfaces :**
- Consumes: `CLASSES`, `DEFAULT_CLASS_ID` (tâche 1), `encodePick` (tâche 2).
- Produces: rien — de l'interface.

- [ ] **Étape 1 : écrire les tests qui échouent**

```ts
describe('etape 8 tache 8 : le choix de classe a l ecran', () => {
  it('affiche les quatre classes, avec leur verbe', () => {
    const racine = document.createElement('div');
    renderClasses(racine, DEFAULT_CLASS_ID, () => {});
    expect(racine.querySelectorAll('[data-classe]').length).toBe(CLASSES.length);
    for (const c of CLASSES) {
      expect(racine.textContent).toContain(c.label);
    }
  });

  it('marque la classe choisie, et une seule', () => {
    const racine = document.createElement('div');
    renderClasses(racine, 2, () => {});
    const choisies = racine.querySelectorAll('[data-choisie="true"]');
    expect(choisies.length).toBe(1);
    expect((choisies[0] as HTMLElement).dataset.classe).toBe('2');
  });

  it('un clic rend l identifiant de la classe cliquee', () => {
    const racine = document.createElement('div');
    const vus: number[] = [];
    renderClasses(racine, DEFAULT_CLASS_ID, (id) => vus.push(id));
    racine.querySelector<HTMLElement>('[data-classe="3"]')?.click();
    expect(vus).toEqual([3]);
  });

  it('les doublons ne sont PAS interdits a l ecran', () => {
    // Deux joueurs sur la meme classe : les deux lignes restent cliquables.
    const racine = document.createElement('div');
    renderClasses(racine, DEFAULT_CLASS_ID, () => {}, [0, 0]);
    for (const el of racine.querySelectorAll('button[data-classe]')) {
      expect((el as HTMLButtonElement).disabled).toBe(false);
    }
  });
});
```

⚠️ **Et le test du CÂBLAGE, pas seulement de la logique.** La doctrine du dépôt est à
`front/src/ui/hud.ts:163` : un test monte le **vrai `index.html`** sous jsdom, parce que c'est la
seule façon de prouver qu'un identifiant du HTML correspond à celui que le code cherche. Une liste
de classes parfaite branchée sur un `id` inexistant est **verte et morte**. Ajoute ce test, et
prouve-le par mutation : change l'`id` et montre qu'il rougit.

- [ ] **Étape 2 : lancer, implémenter, relancer**

```bash
cd front && npx vitest run
```

L'écran envoie `encodePick(armeChoisie, classeChoisie)` à chaque changement — **les deux ensemble**,
puisque `PICK` porte les deux.

- [ ] **Étape 3 : lint, typecheck, commit**

```bash
cd .. && npm run lint && npm run typecheck
git add front/src/ui/room.ts front/src/ui/room.test.ts front/index.html
git commit -m "feat(front): le choix de classe sur l ecran d attente

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```

---

## Tâche 9 : le livrable, et la campagne de mutation

**Files :**
- Create: `back/src/classes.integration.test.ts`

- [ ] **Étape 1 : écrire le livrable**

Le livrable en une phrase : **un joueur choisit une classe au salon, et son verbe agit dans la
partie sans que la simulation dérive.** Reprends le harnais de `back/src/lobby.integration.test.ts`
(**duplique**, n'importe pas : aucun fichier d'intégration de ce dépôt n'en importe un autre).

Quatre tests, un par verbe, sur **vraies sockets** : le joueur choisit sa classe au salon, la partie
démarre, il demande son verbe, et l'effet est observable **à travers le décodage** — jamais depuis
l'état interne du serveur.

Plus les deux qui décident :

```ts
  it('le SNAPSHOT ne grossit pas d un octet, verbes utilises ou non', async () => {
    // Nombres NUS : contrat de fil.
    expect(SNAPSHOT_PLAYER_BYTES).toBe(10);
    expect(SNAPSHOT_HEADER_BYTES + 4 * SNAPSHOT_PLAYER_BYTES).toBe(62);

    // ⚠️ Et la MESURE REELLE, comparee a une VALEUR — pas seulement a
    // elle-meme. C'est la septieme forme du « decor qui masque », nommee a
    // l'etape 7b : la mesure prise puis jamais comparee. Un instantane qui
    // aurait grossi serait uniforme lui aussi, donc vert.
    const tailles = tailleParType(client, MSG.SNAPSHOT);
    expect(tailles.length).toBeGreaterThan(0);
    expect(tailles.every((t) => t === SNAPSHOT_HEADER_BYTES + SNAPSHOT_PLAYER_BYTES)).toBe(true);
  });

  it('ABILITY_USED ne part QUE sur acceptation', async () => {
    // Deux demandes dans le meme tick : une seule annonce.
    client.ws.send(encodeAbility(tickCourant, 1, 0));
    client.ws.send(encodeAbility(tickCourant, 1, 0));
    await attendre(() => true, 'annonces', 500);
    expect(client.received.filter((m) => m.type === MSG.ABILITY_USED).length).toBe(1);
  });
```

- [ ] **Étape 2 : lancer cinq fois**

```bash
export DATABASE_URL='postgresql://tarnok:tarnok@127.0.0.1:5442/tarnok'
cd back && npx vitest run src/classes.integration.test.ts
```

**Donne les cinq résultats.** Un seul rouge sur cinq et le décor n'est pas déterministe.

- [ ] **Étape 3 : COMMIT, puis la campagne de mutation**

Le commit vient **avant** la campagne : elle restaure par `git checkout` et effacerait tout travail
non committé.

| Mutation | Fichier | Doit faire rougir |
| --- | --- | --- |
| `useAbility` ignore la recharge | `back/src/room.ts` | tâche 3, « refuse jusqu'a la recharge » |
| `useAbility` accepte un joueur mort | `back/src/room.ts` | tâche 3, « un joueur mort est refuse » |
| `PICK` enregistre un `classId` hors catalogue | `back/src/server.ts` | tâche 2, Review Focus n°1 |
| `substituteDecoys` pousse le leurre a la fin au lieu de substituer | `shared/decoys.ts` | tâche 6, scénario AP (dérive) |
| `substituteDecoys` ignore l'expiration | `shared/decoys.ts` | tâche 6 |
| un seul des trois sites appelle `substituteDecoys` | `front/src/net/client.ts` | tâche 6, scénario AP |
| `armorOf` rend la SOMME au lieu du maximum | `back/src/room.ts` | tâche 5, « par le MAXIMUM » |
| `resolveContact` lit `accountBonuses.armor` au lieu de `armorOf` | `back/src/combat.ts` | tâche 5, par les PV |
| le trait `residuPartout` s'applique a tout le monde | `back/src/room.ts` | tâche 4, « sans le trait, rien » |
| le Relais pose la recharge avant de valider sa cible | `back/src/room.ts` | tâche 7, « un refus ne consomme pas » |

**Applique la mutation, ne la raisonne pas.** Compte les rouges **sur le fichier entier**, jamais
avec `-t`, et donne la commande exacte. **Une mutation qui reste verte est un trou** : dis-le,
ajoute l'assertion, re-committe.

---

## Tâche 10 : résultats et README

**Files :**
- Create: `docs/plans/2026-10-13-etape-8-resultats.md`
- Modify: `README.md`

- [ ] **Étape 1 : le portique complet, lancé par le COORDINATEUR**

⚠️ **Pas par toi.** `npm test` dure douze minutes et le harnais le détache à deux. Demande les
chiffres au coordinateur.

- [ ] **Étape 2 : le document de résultats**

Mêmes sections que `docs/plans/2026-10-11-etape-7b-resultats.md`. Y inscrire au minimum :

- **le livrable**, et ce qui le distingue : les quatre verbes agissent, et la horde converge
  toujours à **0,000 px** malgré les leurres ;
- **le coût sur le fil** : `SNAPSHOT_PLAYER_BYTES` **reste à 10**. La classe coûte **1 octet par
  joueur, une fois** ; le verbe une trame par usage. Contraste avec l'étape 7b, qui avait payé un
  octet **par tick** par décision explicite ;
- **la prémisse levée** : l'interdit de l'arme signature est tombé avec la salle d'attente, donc la
  raison du §6.7 est caduque et sa conclusion tient. Le §6.7 et le §7.1 de l'orientation **doivent
  être amendés** : la négociation lourde des éléments s'est déplacée du premier étalage vers l'écran
  d'attente ;
- **le trait d'Amorce a été redessiné une fois**, parce que la première version (« votre zone
  survit à la réaction ») ne faisait **rien** : aucune réaction ne consomme la zone qui l'a
  déclenchée, les zones ne meurent que de vieillesse. C'eût été un cinquième mécanisme mort ;
- **l'abus évité** : la boutique vendant `Armure` sur cinq paliers, une somme avec le Rempart aurait
  donné une quasi-immunité qui se paie en or, donc qui se verrait mal. Le maximum est la même règle
  que `ZoneField` applique déjà ;
- **les erreurs du plan, et qui les a trouvées** — franchement, comme le fait le document de 5c
  pour ses quatre mécanismes morts ;
- **les dettes reportées**, dont les **six parties dues** (5b §4, 6a §3, 5c §12, 7a §10, 7b §8, et
  celle-ci), l'atlas absent de MinIO, la salle pleine non testée, et les **deux défauts de la salle
  d'attente** si sa propre étape ne les a pas corrigés : le choix d'arme qui ne vérifie aucun
  déblocage, et `libres` qui n'exclut pas les armes déjà prises.

- [ ] **Étape 3 : le README**

Une ligne de tableau pour l'étape 8, et un paragraphe au niveau où le README parle des autres
étapes : quatre classes, un verbe et un trait, le choix au salon. **Pas de protocole.**

- [ ] **Étape 4 : commit**

```bash
git add docs/plans/2026-10-13-etape-8-resultats.md README.md
git commit -m "docs: resultats de l etape 8

Claude-Session: https://claude.ai/code/session_01DGXTx9caQ9A5yxnLJRrT83"
```
