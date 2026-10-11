import { CARD, type Card } from '@shared/cards';
import { DRAFT_WINDOW_TICKS, WEAPON_SLOTS } from '@shared/constants';
import { Loadout } from '@shared/loadout';
import { PASSIVES } from '@shared/passives';
import { OUTCOME } from '@shared/protocol';
import { BASE_WEAPON_ID, WEAPONS } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { Draft } from './draft';

/**
 * Etalage d'epreuve : sept cartes, toutes OUVERTES A TOUS.
 *
 * ⚠️ **Plus aucune carte n'est reservee.** `owner` a disparu avec les montees
 * de niveau et les evolutions : l'eligibilite se derive de l'inventaire
 * (`Loadout.canTake`), et un etalage ne sait plus qui a droit a quoi.
 */
function spread(): Card[] {
  return [
    { nature: CARD.WEAPON, refId: 1 }, // 0
    { nature: CARD.PASSIVE, refId: 2 }, // 1
    { nature: CARD.WEAPON, refId: 3 }, // 2
    { nature: CARD.WEAPON, refId: 4 }, // 3
    { nature: CARD.PASSIVE, refId: 4 }, // 4
    { nature: CARD.PASSIVE, refId: 0 }, // 5
    { nature: CARD.PASSIVE, refId: 3 }, // 6
  ];
}

/**
 * Les armes du catalogue que l'etalage d'epreuve ne propose PAS — de quoi
 * remplir TOUS les slots d'un joueur sans qu'aucune carte n'y soit deja
 * possedee.
 *
 * ⚠️ **Derivee de `WEAPON_SLOTS`, jamais recopiee.** Cette liste valait
 * `[2, 5, 6, 7, 8]` en dur : passer les slots de 5 a 4 (tache 19) faisait
 * lever `addWeapon` au module et emportait tout le fichier. Deux tests de ce
 * depot sont deja devenus intermittents pour avoir recopie `WAVE1_MIN_COUNT`.
 *
 * La garde ci-dessous reste : elle dit qu'il n'y a plus assez d'armes au
 * catalogue hors etalage pour remplir un inventaire — le jour ou `WEAPON_SLOTS`
 * depasserait ce que `WEAPONS` peut fournir, c'est la fixture qui est fausse,
 * pas le code teste.
 */
const ARMES_DE_L_ETALAGE = new Set(
  spread()
    .filter((c) => c.nature === CARD.WEAPON)
    .map((c) => c.refId),
);
const ARMES_HORS_ETALAGE = WEAPONS.filter(
  (w) => w.id !== BASE_WEAPON_ID && !ARMES_DE_L_ETALAGE.has(w.id),
)
  .slice(0, WEAPON_SLOTS)
  .map((w) => w.id);
if (ARMES_HORS_ETALAGE.length !== WEAPON_SLOTS) {
  throw new Error('fixture : il faut de quoi remplir exactement les slots d armes');
}

const JOUEURS = [1, 2, 3];
/** Un tirage qui rend toujours la meme valeur : gagnant previsible. */
const fixe = (v: number) => () => v;

function ouvert(
  joueurs: readonly number[] = JOUEURS,
  loadouts: ReadonlyMap<number, Loadout> = new Map(),
): Draft {
  const d = new Draft();
  d.open(100, spread(), joueurs, loadouts);
  return d;
}

describe('Draft — le jeton', () => {
  it('accepte mon jeton sur une carte qu un AUTRE vise deja : c est ca, la negociation', () => {
    // ⚠️ **Sans ce comportement il n'y a pas de draft, seulement une course au
    // clic.** Le §7.2 point 3 est explicite : *« quand un joueur a selectionne
    // une carte, je peux poser mon jeton dessus »*. Une implementation qui
    // refuserait la carte deja visee rendrait tout conflit impossible — et
    // toutes les regles de resolution ci-dessous deviendraient du code mort.
    const d = ouvert();
    expect(d.setToken(2, 4)).toBe(true);
    expect(d.setToken(1, 4)).toBe(true);
    expect(d.setToken(3, 4)).toBe(true);
    // Les trois jetons coexistent bel et bien sur la meme carte.
    expect([...d.intents().entries()].sort()).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
    ]);
  });

  it('accepte le deplacement du jeton tant que la fenetre est ouverte', () => {
    const d = ouvert();
    d.setToken(2, 0);
    expect(d.intents().get(2)).toBe(0);
    d.setToken(2, 4);
    expect(d.intents().get(2)).toBe(4);
    expect([...d.intents().values()].filter((v) => v === 0)).toHaveLength(0);
  });

  it('refuse un jeton hors de l etalage', () => {
    const d = ouvert();
    expect(d.setToken(1, 99)).toBe(false);
    expect(d.setToken(1, -1)).toBe(false);
  });

  it("refuse un jeton sur une carte que l'inventaire ne peut pas accueillir", () => {
    // ⚠️ **C'est ce qui remplace `owner`** : l'eligibilite ne voyage plus sur
    // la carte, elle se derive de l'inventaire. La MEME carte est donc
    // refusee a l'un et offerte a l'autre — et c'est le seul cas ou un jeton
    // se refuse encore.
    const pleins = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      // Des armes qui ne figurent dans AUCUNE carte de l'etalage : l'etalage
      // n'offre que les armes 1, 3 et 4.
      pleins.addWeapon(ARMES_HORS_ETALAGE[i] ?? 0);
    }
    const vide = new Loadout();
    const d = ouvert(
      JOUEURS,
      new Map([
        [1, pleins],
        [2, vide],
      ]),
    );

    // La carte 0 est une arme NOUVELLE pour le joueur 1 : ses slots sont pleins.
    expect(d.setToken(1, 0)).toBe(false);
    // ... offerte au joueur 2, dont l'inventaire est vide.
    expect(d.setToken(2, 0)).toBe(true);
    // ... et le joueur 1 reste libre de prendre un PASSIF, dont les slots sont
    // intacts : c'est bien la nature de la carte qui est consultee, pas un
    // refus global.
    expect(d.setToken(1, 1)).toBe(true);
  });

  it('refuse un jeton hors fenetre, et de la part de qui ne participe pas', () => {
    const d = ouvert();
    expect(d.setToken(99, 0)).toBe(false); // pas dans la partie
    d.step(100 + DRAFT_WINDOW_TICKS, fixe(0));
    expect(d.phase).toBe('closed');
    expect(d.setToken(1, 0)).toBe(false);
  });
});

describe('Draft — la resolution, un seul moment', () => {
  it('ne donne la carte contestee qu a UN seul, les autres perdent', () => {
    const d = ouvert();
    d.setToken(1, 2);
    d.setToken(2, 2);
    d.setToken(3, 2);
    const issues = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0));
    if (!issues) {
      throw new Error('la fenetre aurait du se fermer');
    }
    const gagnants = issues.filter((r) => r.cardIndex === 2 && r.outcome === OUTCOME.WON);
    const perdants = issues.filter((r) => r.outcome === OUTCOME.LOST);
    expect(gagnants).toHaveLength(1);
    expect(perdants).toHaveLength(2);
  });

  it('tire le gagnant du rng injecte : deux graines, deux gagnants', () => {
    const gagnantAvec = (v: number) => {
      const d = ouvert();
      d.setToken(1, 2);
      d.setToken(2, 2);
      const issues = d.step(100 + DRAFT_WINDOW_TICKS, fixe(v)) ?? [];
      return issues.find((r) => r.outcome === OUTCOME.WON)?.playerId;
    };
    expect(gagnantAvec(0)).not.toBe(gagnantAvec(0.99));
  });

  it('attribue une carte a un joueur qui n a pose aucun jeton', () => {
    const d = ouvert();
    d.setToken(1, 0);
    // Les joueurs 2 et 3 restent absents.
    const issues = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0)) ?? [];
    for (const id of JOUEURS) {
      expect(issues.find((r) => r.playerId === id)).toBeDefined();
    }
    expect(issues.filter((r) => r.outcome === OUTCOME.AUTO)).toHaveLength(2);
  });

  it('un absent ne prive jamais un present de la carte qu il vise', () => {
    // ⚠️ C'est la PROPRIETE que la regle d'attribution est censee garantir,
    // pas la regle elle-meme. Quelqu'un qui « simplifierait » l'ordre — en
    // servant les absents d'abord — la casserait sans casser un test qui ne
    // verifierait que l'ordre.
    // ⚠️ La collision doit exister pour que le test morde. Le joueur 3 vise la
    // carte 0 — la PREMIERE libre, donc exactement celle que l'attribution
    // d'office donnerait au joueur 1, qui reste absent. Avec les absents
    // servis en premier, le joueur 3 perdrait la sienne. Verifie : sans cette
    // collision, la mutation survivait.
    for (let seed = 0; seed < 20; seed++) {
      const d = ouvert();
      d.setToken(3, 0);
      const issues = d.step(100 + DRAFT_WINDOW_TICKS, fixe(seed / 20)) ?? [];
      const sien = issues.find((r) => r.playerId === 3);
      expect(sien?.cardIndex).toBe(0);
      expect(sien?.outcome).toBe(OUTCOME.WON);
      expect(issues.find((r) => r.playerId === 1)?.cardIndex).not.toBe(0);
    }
  });

  it('tranche les cartes par indice CROISSANT, jamais dans l ordre ou les joueurs ont rejoint', () => {
    // ⚠️ `#resolve` groupe les jetons en parcourant `#pending`, donc l'ordre
    // d'insertion dans la `Map` suit l'ordre d'ARRIVEE DES JOUEURS dans le
    // salon. Sans le tri, deux salons portant exactement les memes jetons —
    // mais peuples dans un ordre different — consommeraient le tirage dans un
    // ordre different et designeraient d'autres gagnants.
    //
    // ⚠️ **Un `rng` CONSTANT ne peut pas voir ca** : il rend la meme valeur a
    // chaque carte, donc l'ordre de consommation n'a aucun effet. Verifie :
    // avec `fixe(0)`, la mutation « ne pas trier » survivait. Il faut une
    // SUITE, et deux valeurs qui ne designent pas le meme pretendant.
    const suite = (...valeurs: number[]) => {
      let i = 0;
      return () => valeurs[i++] ?? 0;
    };
    const resout = (ordreDArrivee: readonly number[]) => {
      const d = ouvert(ordreDArrivee);
      // Deux cartes disputees, deux paires : les jetons sont IDENTIQUES d'un
      // salon a l'autre, seul l'ordre d'arrivee change.
      for (const [id, index] of [
        [1, 4],
        [2, 4],
        [3, 1],
        [4, 1],
      ] as const) {
        expect(d.setToken(id, index)).toBe(true);
      }
      return (d.step(100 + DRAFT_WINDOW_TICKS, suite(0, 0.99)) ?? [])
        .map((r) => `${r.playerId}:${r.cardIndex}:${r.outcome}`)
        .sort();
    };
    expect(resout([1, 2, 3, 4])).toEqual(resout([3, 4, 1, 2]));
  });

  it('attend que TOUS aient pose, pas seulement le premier', () => {
    // ⚠️ **La fenetre ne se referme pas au premier clic a plusieurs.** Si elle
    // le faisait, le plus rapide trancherait pour tout le monde : les deux
    // autres passeraient par l'attribution d'office sans avoir eu la main, et
    // la negociation du §7.2 n'aurait jamais lieu. Verifie par mutation : sans
    // ce test, `every` remplace par `some` survivait a toute la suite.
    const d = ouvert();
    expect(d.setToken(1, 0)).toBe(true);
    expect(d.step(101, fixe(0)), 'ferme des le premier jeton').toBeNull();
    expect(d.phase).toBe('open');

    expect(d.setToken(2, 1)).toBe(true);
    expect(d.step(102, fixe(0)), 'ferme avant le dernier jeton').toBeNull();
    expect(d.phase).toBe('open');

    // Le dernier pose : LA, et seulement la, la fenetre se referme — bien
    // avant l'echeance.
    expect(d.setToken(3, 2)).toBe(true);
    expect(d.step(103, fixe(0))).not.toBeNull();
    expect(d.phase).toBe('closed');
  });

  it('la fermeture ne laisse AUCUN jeton derriere elle', () => {
    // ⚠️ **Defaut signale par l'auteur en jouant** : « si je selectionne un
    // passif et qu'au niveau suivant il est encore la, j'ai deja mon jeton
    // dessus et je peux pas le reprendre ».
    //
    // `Session#broadcast` diffuse `DRAFT_INTENTS` des que `intents()` n'est pas
    // vide. Les jetons survivaient a la fermeture, donc le serveur rediffusait
    // celui du tour precedent **a chaque tick** jusqu'a l'ouverture suivante.
    // Le joueur voyait son propre jeton deja pose sur une carte du nouvel
    // etalage — et comme le §4.1 fait du reclic un RETRAIT, cliquer la carte
    // qu'il voulait la lui refusait.
    const d = ouvert();
    d.setToken(1, 0);
    d.setToken(2, 1);
    d.setToken(3, 6);
    expect(d.intents().size).toBe(3);

    const issues = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0));
    expect(d.phase).toBe('closed');
    expect(issues).not.toBeNull();
    expect(d.intents().size).toBe(0);
  });

  it('ne rend qu UN SEUL lot d issues : rejouer `step` ne rouvre rien', () => {
    // ⚠️ **La repioche a disparu.** Il y avait ici une seconde fenetre de 5 s
    // et un second lot d'issues ; la resolution est desormais un seul moment,
    // et `phase` n'a plus que deux etats.
    const d = ouvert();
    d.setToken(1, 2);
    d.setToken(2, 2);
    d.setToken(3, 2);
    expect(d.step(100 + DRAFT_WINDOW_TICKS, fixe(0))).not.toBeNull();
    expect(d.phase).toBe('closed');
    expect(d.step(100 + DRAFT_WINDOW_TICKS + 1, fixe(0))).toBeNull();
    expect(d.step(100 + DRAFT_WINDOW_TICKS + 600, fixe(0))).toBeNull();
  });
});

describe('Draft — le perdant est servi dans le MEME lot', () => {
  it('recoit le LOST de la carte disputee ET l AUTO de celle qui la remplace', () => {
    // ⚠️ **C'est l'histoire que l'ecran doit raconter** : *« ca brule la carte
    // si je l'ai pas eu et ca en illumine une autre »*. Les deux issues
    // arrivent ensemble — un second message n'existe plus, donc un ecran qui
    // attendrait la suite ne verrait jamais rien s'illuminer.
    const d = ouvert();
    d.setToken(1, 2);
    d.setToken(2, 2);
    d.setToken(3, 2);
    const lot = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0)) ?? [];

    const perdants = lot.filter((r) => r.outcome === OUTCOME.LOST);
    expect(perdants, 'le conflit doit avoir lieu, on le COMPTE').toHaveLength(2);

    for (const perdu of perdants) {
      const siennes = lot.filter((r) => r.playerId === perdu.playerId);
      expect(siennes, `le joueur ${perdu.playerId} n a recu qu une issue`).toHaveLength(2);
      const remplacement = siennes.find((r) => r.outcome === OUTCOME.AUTO);
      expect(remplacement).toBeDefined();
      // Jamais la carte qu'il vient de perdre : elle est prise.
      expect(remplacement?.cardIndex).not.toBe(perdu.cardIndex);
    }

    // Les trois joueurs repartent avec une carte, et jamais la meme.
    const prises = lot.filter((r) => r.outcome !== OUTCOME.LOST);
    expect(new Set(prises.map((r) => r.playerId)).size).toBe(3);
    expect(new Set(prises.map((r) => r.cardIndex)).size).toBe(prises.length);
  });

  it('deux perdants recoivent DEUX cartes de remplacement DIFFERENTES', () => {
    // ⚠️ Ce test existe parce qu'une mutation survivait au precedent quand il
    // ne produisait qu'un seul perdant : retirer `this.#taken.add(index)` de
    // l'attribution d'office ne cassait rien, faute de collision possible.
    // Il en faut DEUX, et aucun autre joueur pour consommer une carte entre
    // les deux — sinon ce sont les cartes deja prises, et non le garde, qui
    // les separent.
    //
    // On COMPTE les perdants, on ne les suppose pas.
    for (let seed = 0; seed < 15; seed++) {
      const d = ouvert([1, 2, 3]);
      for (const id of [1, 2, 3]) {
        expect(d.setToken(id, 2)).toBe(true);
      }
      const lot = d.step(100 + DRAFT_WINDOW_TICKS, fixe(seed / 15)) ?? [];
      expect(lot.filter((r) => r.outcome === OUTCOME.LOST)).toHaveLength(2);
      const dOffice = lot.filter((r) => r.outcome === OUTCOME.AUTO);
      expect(dOffice).toHaveLength(2);
      expect(new Set(dOffice.map((r) => r.playerId)).size).toBe(2);
      expect(new Set(dOffice.map((r) => r.cardIndex)).size).toBe(2);
      // Et aucune ne redonne la carte que le gagnant vient de prendre.
      const gagnee = lot.find((r) => r.outcome === OUTCOME.WON)?.cardIndex;
      expect(dOffice.every((r) => r.cardIndex !== gagnee)).toBe(true);
    }
  });

  it("n'attribue d'office que ce que l'inventaire peut accueillir", () => {
    // Un joueur aux slots d'armes pleins ne se voit jamais coller une arme
    // NOUVELLE d'office : `#autoPick` consulte la meme eligibilite que
    // `setToken`. Sans cette consultation, `Room#grantCard` leverait, ou pire,
    // avalerait la carte en silence.
    const pleins = new Loadout();
    for (let i = 0; i < WEAPON_SLOTS; i++) {
      pleins.addWeapon(ARMES_HORS_ETALAGE[i] ?? 0);
    }
    const d = ouvert([1, 2], new Map([[1, pleins]]));
    // Personne ne pose : les deux passent par l'attribution d'office.
    const lot = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0)) ?? [];
    const sien = lot.find((r) => r.playerId === 1);
    expect(sien).toBeDefined();
    // La carte 0 est une arme : la premiere carte que ce joueur peut accueillir
    // est le PASSIF d'indice 1.
    expect(sien?.cardIndex).toBe(1);
    expect(spread()[sien?.cardIndex ?? -1]?.nature).toBe(CARD.PASSIVE);
  });

  it('rend un lot sans remplacement quand plus rien n est disponible', () => {
    // Cas limite honnete : si l'etalage est epuise, le perdant repart les
    // mains vides et le lot ne porte que son `LOST`. Rien ne doit boucler ni
    // lever — c'est l'ecran qui le dit au joueur.
    const d = new Draft();
    d.open(100, [{ nature: CARD.PASSIVE, refId: 2 }], [1, 2]);
    expect(d.setToken(1, 0)).toBe(true);
    expect(d.setToken(2, 0)).toBe(true);
    const lot = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0)) ?? [];
    expect(lot).toHaveLength(2);
    expect(lot.filter((r) => r.outcome === OUTCOME.AUTO)).toHaveLength(0);
  });
});

describe('Draft — le solo', () => {
  it('se ferme au jeton pose, sans attendre l echeance', () => {
    const d = ouvert([1]);
    expect(d.phase).toBe('open');
    d.setToken(1, 0);
    const issues = d.step(101, fixe(0)); // un seul tick apres l ouverture
    expect(issues).not.toBeNull();
    expect(d.phase).toBe('closed');
    expect(issues?.[0]?.cardIndex).toBe(0);
  });

  it('n avance pas tant que le joueur n a pas pose', () => {
    const d = ouvert([1]);
    expect(d.step(150, fixe(0))).toBeNull();
    expect(d.phase).toBe('open');
  });
});

describe('etape 7b tache 3 : un jeton sur une carte non debloquee est refuse', () => {
  it('refuse le jeton, et le refus ne depend pas du Loadout', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const draft = new Draft();
    const loadouts = new Map([[1, new Loadout()]]);
    const spread = [{ nature: CARD.WEAPON, refId: verrouillee.id }];
    // Le joueur 1 n'a RIEN debloque.
    draft.open(0, spread, [1], loadouts, new Map([[1, new Set<number>()]]));

    // Son Loadout pourrait parfaitement accueillir cette arme :
    expect(loadouts.get(1)?.canTake(CARD.WEAPON, verrouillee.id)).toBe(true);
    // ...et le jeton est refuse quand meme.
    expect(draft.setToken(1, 0)).toBe(false);
  });

  it('accepte le meme jeton des que l arme est debloquee', () => {
    const verrouillee = WEAPONS.find((w) => w.locked);
    if (!verrouillee) {
      throw new Error('aucune arme verrouillee');
    }
    const draft = new Draft();
    const loadouts = new Map([[1, new Loadout()]]);
    const spread = [{ nature: CARD.WEAPON, refId: verrouillee.id }];
    draft.open(0, spread, [1], loadouts, new Map([[1, new Set([verrouillee.id])]]));
    expect(draft.setToken(1, 0)).toBe(true);
  });

  it('un passif n est jamais concerne par les deblocages', () => {
    const p = PASSIVES[0];
    if (!p) {
      throw new Error('aucun passif');
    }
    const draft = new Draft();
    const loadouts = new Map([[1, new Loadout()]]);
    draft.open(
      0,
      [{ nature: CARD.PASSIVE, refId: p.id }],
      [1],
      loadouts,
      new Map([[1, new Set<number>()]]),
    );
    expect(draft.setToken(1, 0)).toBe(true);
  });
});
