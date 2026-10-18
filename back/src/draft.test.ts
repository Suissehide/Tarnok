import { CARD, type Card } from '@shared/cards';
import { DRAFT_WINDOW_TICKS, WEAPON_SLOTS } from '@shared/constants';
import { Loadout } from '@shared/loadout';
import { OUTCOME } from '@shared/protocol';
import { BASE_WEAPON_ID, WEAPONS } from '@shared/weapons';
import { describe, expect, it } from 'vitest';

import { Draft } from './draft';

/**
 * Etalage d'epreuve : sept cartes, toutes OUVERTES A TOUS.
 *
 * Aucune carte n'est reservee : l'eligibilite se derive de l'inventaire
 * (`Loadout.canTake`), un etalage ne sait pas qui a droit a quoi.
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
 * ⚠️ **Derivee de `WEAPON_SLOTS`, jamais recopiee** : une liste en dur fait
 * lever `addWeapon` au module des que le nombre de slots change.
 *
 * La garde ci-dessous dit qu'il n'y a plus assez d'armes au catalogue hors
 * etalage pour remplir un inventaire : c'est alors la fixture qui est fausse,
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
    // clic.** Refuser la carte deja visee rendrait tout conflit impossible, et
    // les regles de resolution ci-dessous deviendraient du code mort.
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
    // ⚠️ L'eligibilite ne voyage pas sur la carte, elle se derive de
    // l'inventaire : la MEME carte est refusee a l'un et offerte a l'autre.
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
    // carte 0, la PREMIERE libre, donc celle que l'attribution d'office
    // donnerait au joueur 1, absent. Avec les absents servis en premier, le
    // joueur 3 perdrait la sienne.
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
    // chaque carte, donc l'ordre de consommation n'a aucun effet. Il faut une
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
    // la negociation n'aurait jamais lieu. C'est le seul test qui distingue
    // `every` de `some`.
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
    // ⚠️ `Session#broadcast` diffuse `DRAFT_INTENTS` des que `intents()` n'est
    // pas vide. Un jeton survivant a la fermeture serait rediffuse **a chaque
    // tick** jusqu'a l'ouverture suivante : le joueur verrait son jeton deja
    // pose sur une carte du nouvel etalage, et comme le reclic est un RETRAIT,
    // cliquer la carte voulue la lui refuserait.
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
    // La resolution est un seul moment : pas de seconde fenetre, et `phase`
    // n'a que deux etats.
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
    // ⚠️ L'ecran brule la carte perdue et en illumine une autre : les deux
    // issues arrivent ensemble, il n'y a pas de second message a attendre.
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
    // ⚠️ Garde `this.#taken.add(index)` dans l'attribution d'office : avec un
    // seul perdant, rien ne peut entrer en collision. Il en faut DEUX, et aucun
    // autre joueur pour consommer une carte entre les deux, sinon ce sont les
    // cartes deja prises, et non le garde, qui les separent.
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
