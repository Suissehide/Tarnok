import { CARD, type Card } from '@shared/cards';
import { DRAFT_REPICK_TICKS, DRAFT_WINDOW_TICKS } from '@shared/constants';
import { OUTCOME } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import { Draft } from './draft';

/**
 * Etalage d'epreuve.
 *
 * ⚠️ Les cartes reservees ne sont PAS en tete, et leur `owner` n'est pas le
 * premier joueur. Trois tests creux de cette etape venaient tous de fixtures
 * ou l'indice 0 ou le joueur 1 masquaient une implementation fausse.
 */
function spread(): Card[] {
  return [
    { nature: CARD.NEW_WEAPON, refId: 1, owner: 0 }, // 0 — libre
    { nature: CARD.PASSIVE, refId: 2, owner: 0 }, // 1 — libre
    { nature: CARD.NEW_WEAPON, refId: 3, owner: 0 }, // 2 — libre
    { nature: CARD.WEAPON_LEVEL, refId: 4, owner: 3 }, // 3 — reservee au joueur 3
    { nature: CARD.NEW_WEAPON, refId: 5, owner: 0 }, // 4 — libre
    { nature: CARD.EVOLUTION, refId: 6, owner: 2 }, // 5 — reservee au joueur 2
    { nature: CARD.PASSIVE, refId: 7, owner: 0 }, // 6 — libre
  ];
}

const JOUEURS = [1, 2, 3];
/** Un tirage qui rend toujours la meme valeur : gagnant previsible. */
const fixe = (v: number) => () => v;

function ouvert(joueurs: readonly number[] = JOUEURS): Draft {
  const d = new Draft();
  d.open(100, spread(), joueurs);
  return d;
}

describe('Draft — le jeton', () => {
  it('refuse un jeton sur une carte reservee a un autre joueur', () => {
    const d = ouvert();
    expect(d.setToken(1, 3)).toBe(false); // la carte 3 appartient au joueur 3
    expect(d.setToken(3, 3)).toBe(true);
    expect(d.intents().get(1)).toBeUndefined();
    expect(d.intents().get(3)).toBe(3);
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
});

describe('Draft — la resolution', () => {
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
    // servant les absents d'abord, ou en ignorant les cartes reservees — la
    // casserait sans casser un test qui ne verifierait que l'ordre.
    // ⚠️ La collision doit exister pour que le test morde. Le joueur 3 vise la
    // carte 0 — la PREMIERE libre, donc exactement celle que l'attribution
    // d'office donnerait au joueur 1, qui n'a aucune carte reservee et reste
    // absent. Avec les absents servis en premier, le joueur 3 perdrait la
    // sienne. Verifie : sans cette collision, la mutation survivait.
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

  it('sert d abord la carte dont un absent est le seul eligible', () => {
    const d = ouvert();
    // Personne ne pose. Le joueur 3 a la carte 3 reservee, le joueur 2 la 5.
    const issues = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0)) ?? [];
    expect(issues.find((r) => r.playerId === 3)?.cardIndex).toBe(3);
    expect(issues.find((r) => r.playerId === 2)?.cardIndex).toBe(5);
  });
});

describe('Draft — la repioche', () => {
  it('s ouvre pour les perdants, et pour eux seuls', () => {
    const d = ouvert();
    d.setToken(1, 2);
    d.setToken(2, 2);
    d.setToken(3, 6);
    d.step(100 + DRAFT_WINDOW_TICKS, fixe(0));
    expect(d.phase).toBe('repick');
    expect(d.deadlineTick).toBe(100 + DRAFT_WINDOW_TICKS + DRAFT_REPICK_TICKS);

    // Le gagnant et le non-conflictuel ne reposent pas de jeton.
    const perdant = d.intents();
    expect(perdant.size).toBe(0);
    const carteDejaPrise = 2;
    expect(d.setToken(3, 0)).toBe(false); // le joueur 3 a deja obtenu la sienne
    expect(d.setToken(1, carteDejaPrise) || d.setToken(2, carteDejaPrise)).toBe(false);
  });

  it('ne boucle pas : un reconflit se tranche et le draft se termine', () => {
    const d = ouvert();
    d.setToken(1, 2);
    d.setToken(2, 2);
    d.setToken(3, 2);
    const premierTour = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0));
    expect(d.phase).toBe('repick');

    // ⚠️ Les jetons doivent aller aux VRAIS perdants, sinon `setToken` les
    // refuse et le reconflit n'a jamais lieu — la mutation « la repioche peut
    // boucler » survivait a un test qui croyait le creer.
    const perdants = (premierTour ?? [])
      .filter((r) => r.outcome === OUTCOME.LOST)
      .map((r) => r.playerId);
    expect(perdants).toHaveLength(2);
    for (const id of perdants) {
      expect(d.setToken(id, 4)).toBe(true);
    }
    const issues = d.step(100 + DRAFT_WINDOW_TICKS + DRAFT_REPICK_TICKS, fixe(0));
    expect(issues).not.toBeNull();
    expect(d.phase).toBe('closed');

    // ⚠️ **Ce test contenait la seizieme assertion creuse de ce projet.** Elle
    // disait « personne ne repart les mains vides » et verifiait
    // `issues.every((r) => r.cardIndex >= 0)`. Le `cardIndex` d'un `LOST` est
    // celui de la carte PERDUE : l'assertion passait pour un joueur qui
    // n'obtenait rien. Le §4.4 est pourtant explicite — « un gagnant est tire,
    // les autres recoivent l'attribution automatique ».
    //
    // La vraie verification compte les joueurs qui repartent AVEC quelque
    // chose. Verifiee par mutation : sans les lignes d'attribution d'office de
    // `Draft#step`, on lit « expected 1 to be 2 ».
    const lot = issues ?? [];
    const servis = new Set(lot.filter((r) => r.outcome !== OUTCOME.LOST).map((r) => r.playerId));
    expect([...servis].sort((a, b) => a - b)).toEqual(perdants.sort((a, b) => a - b));

    // Et jamais deux fois la meme carte : l'attribution d'office respecte ce
    // que le gagnant vient de prendre.
    const prises = lot.filter((r) => r.outcome !== OUTCOME.LOST).map((r) => r.cardIndex);
    expect(new Set(prises).size).toBe(prises.length);

    // Le perdant du reconflit recoit DEUX issues : la carte perdue, puis celle
    // qu'il obtient a la place. C'est l'histoire que le §4.2 demande de
    // raconter a l'ecran.
    for (const id of perdants) {
      const siennes = lot.filter((r) => r.playerId === id);
      expect(siennes.length).toBeGreaterThanOrEqual(1);
    }
    const reperdant = lot.find((r) => r.outcome === OUTCOME.LOST)?.playerId;
    if (reperdant !== undefined) {
      expect(lot.filter((r) => r.playerId === reperdant)).toHaveLength(2);
    }
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
    //
    // Aucun test ne le voyait : les trois etats de `phase` etaient couverts,
    // mais rien ne regardait ce que la machine laissait derriere elle.
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

  it('deux perdants d un reconflit recoivent DEUX cartes differentes', () => {
    // ⚠️ Ce test existe parce qu'une mutation a survecu au precedent : retirer
    // `this.#taken.add(index)` de l'attribution d'office ne cassait rien, car
    // le scenario a trois joueurs ne produit **qu'un seul** perdant au
    // reconflit — rien ne pouvait entrer en collision.
    //
    // Il en faut DEUX. Quatre joueurs sur la meme carte : un gagnant, trois
    // perdants ; puis les trois sur la meme carte restante : un gagnant, deux
    // perdants, donc deux attributions d'office qui doivent se partager ce qui
    // reste.
    //
    // ⚠️ Joueurs **1, 4, 5 et 6**, et pas 1 a 4. Les cartes 3 et 5 de
    // l'etalage d'epreuve sont reservees aux joueurs 3 et 2 : avec eux dans la
    // partie, chaque perdant recoit SA carte reservee et les deux attributions
    // divergent sans que le garde y soit pour rien — la mutation survivait a
    // une premiere version de ce test. Aucun de ces quatre-la n'a de carte
    // reservee, donc les deux attributions visent la meme carte libre et seul
    // `#taken` les separe.
    const d = ouvert([1, 4, 5, 6]);
    for (const id of [1, 4, 5, 6]) {
      expect(d.setToken(id, 2)).toBe(true);
    }
    const premier = d.step(100 + DRAFT_WINDOW_TICKS, fixe(0)) ?? [];
    expect(d.phase).toBe('repick');
    const perdants = premier.filter((r) => r.outcome === OUTCOME.LOST).map((r) => r.playerId);
    expect(perdants).toHaveLength(3);

    for (const id of perdants) {
      expect(d.setToken(id, 4)).toBe(true);
    }
    const second = d.step(100 + DRAFT_WINDOW_TICKS + DRAFT_REPICK_TICKS, fixe(0)) ?? [];
    expect(d.phase).toBe('closed');

    const dOffice = second.filter((r) => r.outcome === OUTCOME.AUTO);
    expect(dOffice).toHaveLength(2);
    // Deux joueurs distincts, et surtout deux cartes DISTINCTES.
    expect(new Set(dOffice.map((r) => r.playerId)).size).toBe(2);
    expect(new Set(dOffice.map((r) => r.cardIndex)).size).toBe(2);
    // Et aucune ne redonne la carte que le gagnant du reconflit vient de
    // prendre.
    const gagnee = second.find((r) => r.outcome === OUTCOME.WON)?.cardIndex;
    expect(dOffice.every((r) => r.cardIndex !== gagnee)).toBe(true);
  });

  it('ne rend jamais deux fois la meme carte a deux joueurs', () => {
    for (let seed = 0; seed < 15; seed++) {
      const d = ouvert();
      d.setToken(1, 2);
      d.setToken(2, 2);
      d.setToken(3, 2);
      const a = d.step(100 + DRAFT_WINDOW_TICKS, fixe(seed / 15)) ?? [];
      for (const r of a.filter((x) => x.outcome === OUTCOME.LOST)) {
        d.setToken(r.playerId, 4);
      }
      const b = d.step(100 + DRAFT_WINDOW_TICKS + DRAFT_REPICK_TICKS, fixe(seed / 15)) ?? [];
      const prises = [...a, ...b].filter((r) => r.outcome !== OUTCOME.LOST).map((r) => r.cardIndex);
      expect(new Set(prises).size).toBe(prises.length);
    }
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
