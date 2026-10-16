import { PORTAL_WINDOW_TICKS, TICK_HZ } from '@shared/constants';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';
import { describe, expect, it } from 'vitest';

import { Portal } from './portal';

const { STAY, LEAVE } = VOTE_CHOICE;

/**
 * ⚠️ **Le decor doit produire le cas qu'il pretend creer.** Ici le piege est
 * **une egalite qu'on croit creer et qui n'en est pas une** : deux departs et
 * une abstention ne sont pas 2-2 mais 2-0, et le test passerait pour une
 * mauvaise raison. Cette fonction compte ce que le decor a REELLEMENT
 * produit, et chaque scenario declare son decompte attendu.
 */
function decompte(portal: Portal): { rester: number; partir: number; silencieux: number } {
  let rester = 0;
  let partir = 0;
  let silencieux = 0;
  for (const choix of portal.votes().values()) {
    if (choix === LEAVE) {
      partir++;
    } else if (choix === STAY) {
      rester++;
    } else {
      silencieux++;
    }
  }
  return { rester, partir, silencieux };
}

describe('le portail : ouverture', () => {
  it('dure VINGT SECONDES, et c est la seule ligne qui le garde', () => {
    // ⚠️ Tout le reste de ce fichier derive ses ticks de la constante et
    // resterait vert si elle valait trois : c'est ici, et nulle part
    // ailleurs, que la promesse des vingt secondes tient.
    expect(PORTAL_WINDOW_TICKS).toBe(20 * TICK_HZ);
  });

  it('date son echeance, et ne rend aucun verdict avant', () => {
    const portal = new Portal();
    expect(portal.phase).toBe('closed');

    portal.open(100, [1, 2, 3]);

    expect(portal.phase).toBe('open');
    expect(portal.deadlineTick).toBe(100 + PORTAL_WINDOW_TICKS);
    // Un tick avant l'echeance, personne n'ayant vote : rien n'est tranche.
    expect(portal.step(portal.deadlineTick - 1)).toBeNull();
    expect(portal.phase).toBe('open');
  });

  it('montre TOUS les participants des l ouverture, silencieux compris', () => {
    const portal = new Portal();
    portal.open(0, [4, 7, 9]);

    // ⚠️ **La visibilite EST la mecanique** : on ne negocie pas un choix
    // qu'on ne voit pas, et « qui n'a pas encore tranche » fait partie de ce
    // qu'il faut voir. Une table qui ne porterait que les votes REELLEMENT
    // poses — comme les jetons du draft — laisserait les silencieux invisibles
    // sur le fil.
    expect([...portal.votes().keys()].sort((a, b) => a - b)).toEqual([4, 7, 9]);
    expect(decompte(portal)).toEqual({ rester: 0, partir: 0, silencieux: 3 });
  });

  it('refuse tout vote hors fenetre, et n en garde aucune trace', () => {
    const portal = new Portal();
    expect(portal.setVote(1, LEAVE)).toBe(false);
    expect(portal.votes().size).toBe(0);
  });
});

describe('le portail : la majorite tranche', () => {
  it('une majorite de departs fait PARTIR — et le camp perdant existe', () => {
    const portal = new Portal();
    portal.open(0, [1, 2, 3]);

    expect(portal.setVote(1, LEAVE)).toBe(true);
    expect(portal.setVote(2, LEAVE)).toBe(true);
    expect(portal.setVote(3, STAY)).toBe(true);

    // ⚠️ **Le decor compte ce qu'il croit avoir pose.** Sans ce releve, un
    // troisieme vote refuse en silence donnerait 2-0 et le test dirait
    // « majorite » d'une unanimite.
    expect(decompte(portal)).toEqual({ rester: 1, partir: 2, silencieux: 0 });

    expect(portal.step(1)).toBe(LEAVE);
    expect(portal.phase).toBe('closed');
  });

  it('une majorite de restants fait RESTER, et le verdict n est pas un defaut', () => {
    const portal = new Portal();
    portal.open(0, [1, 2, 3]);
    portal.setVote(1, STAY);
    portal.setVote(2, STAY);
    portal.setVote(3, LEAVE);

    expect(decompte(portal)).toEqual({ rester: 2, partir: 1, silencieux: 0 });
    expect(portal.step(1)).toBe(STAY);
  });

  it('ferme des que TOUT LE MONDE a vote, sans attendre l echeance', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);
    portal.setVote(1, LEAVE);

    // Un seul votant sur deux : la negociation continue.
    expect(portal.step(1)).toBeNull();

    portal.setVote(2, LEAVE);
    expect(portal.step(2)).toBe(LEAVE);
    // Et bien avant l'echeance : vingt secondes de monde qui tourne sont
    // rendues a l'equipe qui a decide vite.
    expect(2).toBeLessThan(portal.deadlineTick);
  });
});

describe("le portail : l'egalite continue (§6)", () => {
  it('QUATRE joueurs, DEUX contre DEUX, tous votants : on continue', () => {
    const portal = new Portal();
    portal.open(0, [1, 2, 3, 4]);
    portal.setVote(1, LEAVE);
    portal.setVote(2, LEAVE);
    portal.setVote(3, STAY);
    portal.setVote(4, STAY);

    // ⚠️ **L'egalite comptee, pas supposee.** 2 departs et 2 silences se
    // liraient aussi comme « egalite » et rendraient « on continue » pour une
    // tout autre raison : le silence, pas l'egalite.
    expect(decompte(portal)).toEqual({ rester: 2, partir: 2, silencieux: 0 });

    expect(portal.step(1)).toBe(STAY);
  });

  it('et un seul depart de plus fait basculer la MEME fixture', () => {
    // ⚠️ **La moitie qui rend le test discriminant.** Sans elle, « egalite =
    // on continue » se lit aussi bien d'une machine qui rendrait TOUJOURS
    // « rester » : le meme decor, une voix deplacee, doit partir.
    const portal = new Portal();
    portal.open(0, [1, 2, 3, 4]);
    portal.setVote(1, LEAVE);
    portal.setVote(2, LEAVE);
    portal.setVote(3, LEAVE);
    portal.setVote(4, STAY);

    expect(decompte(portal)).toEqual({ rester: 1, partir: 3, silencieux: 0 });
    expect(portal.step(1)).toBe(LEAVE);
  });
});

describe("le portail : l'absence ne bloque jamais (§4.4 de l'etape 4)", () => {
  it('tranche a l echeance avec ce qu il a : UNE voix contre DEUX silences fait partir', () => {
    const portal = new Portal();
    portal.open(0, [1, 2, 3]);
    portal.setVote(2, LEAVE);

    expect(decompte(portal)).toEqual({ rester: 0, partir: 1, silencieux: 2 });
    // La fenetre va a son terme : deux joueurs n'ont pas tranche.
    expect(portal.step(portal.deadlineTick - 1)).toBeNull();

    // ⚠️ **Le seul test qui distingue la sentinelle `NO_VOTE` d'un zero.** A
    // `NO_VOTE = STAY = 0`, les deux silencieux voteraient « rester » et ce
    // salon resterait a 2 contre 1.
    expect(portal.step(portal.deadlineTick)).toBe(LEAVE);
  });

  it('un salon entierement silencieux continue, il ne bloque pas', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);

    expect(decompte(portal)).toEqual({ rester: 0, partir: 0, silencieux: 2 });
    expect(portal.step(portal.deadlineTick)).toBe(STAY);
    expect(portal.phase).toBe('closed');
  });

  it('un salon VIDE tranche au premier pas, et il continue', () => {
    // Tout le monde s'est deconnecte pendant le vote : on continue, et
    // l'echeance est immediate puisqu'on n'attend plus personne.
    const portal = new Portal();
    portal.open(0, []);
    expect(portal.step(1)).toBe(STAY);
  });
});

describe('le portail : ce qui est refuse, et ce qui est revocable', () => {
  it('un joueur etranger au vote ne vote pas', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);

    expect(portal.setVote(9, LEAVE)).toBe(false);
    expect(portal.votes().has(9)).toBe(false);
    // Le vote des presents n'en est pas altere : 0-0, deux silencieux.
    expect(decompte(portal)).toEqual({ rester: 0, partir: 0, silencieux: 2 });
  });

  it('un choix qui n existe pas est refuse, et ne devient pas un vote fantome', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);
    portal.setVote(1, LEAVE);

    // ⚠️ Le choix vient du FIL : un client quelconque peut poser n'importe
    // quel octet. Sans le garde, `7` entrerait dans la table, partirait tel
    // quel dans `VOTES` et ne se compterait nulle part — une abstention
    // silencieuse qui ne ressemblerait pas a `NO_VOTE`.
    expect(portal.setVote(2, 7)).toBe(false);
    expect(portal.votes().get(2)).toBe(NO_VOTE);
    // Et il n'a pas ferme la fenetre au passage : le joueur 2 n'a pas vote.
    expect(portal.step(1)).toBeNull();
  });

  it('un vote se change, et se retire', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);

    portal.setVote(1, STAY);
    portal.setVote(1, LEAVE);
    expect(portal.votes().get(1)).toBe(LEAVE);

    // Revocable, comme un jeton du draft : on negocie pendant vingt secondes.
    expect(portal.setVote(1, NO_VOTE)).toBe(true);
    expect(decompte(portal)).toEqual({ rester: 0, partir: 0, silencieux: 2 });
    // Et le retrait rouvre bien l'attente : plus personne n'a vote.
    expect(portal.step(1)).toBeNull();
  });
});

describe('le portail : un seul verdict, et rien ne lui survit', () => {
  it('ne rend son verdict qu une fois', () => {
    const portal = new Portal();
    portal.open(0, [1]);
    portal.setVote(1, LEAVE);

    expect(portal.step(1)).toBe(LEAVE);
    expect(portal.step(2)).toBeNull();
    expect(portal.step(portal.deadlineTick + 1)).toBeNull();
  });

  it('vide les votes en se fermant : le portail suivant part vierge', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);
    portal.setVote(1, LEAVE);
    portal.setVote(2, LEAVE);
    portal.step(1);

    // ⚠️ **Sans cette ligne, `VOTES` rediffuserait les voix du palier
    // precedent a chaque tick** jusqu'au portail suivant : chacun verrait son
    // vote deja pose avant d'avoir decide.
    expect(portal.votes().size).toBe(0);

    portal.open(100, [1, 2]);
    expect(decompte(portal)).toEqual({ rester: 0, partir: 0, silencieux: 2 });
    expect(portal.deadlineTick).toBe(100 + PORTAL_WINDOW_TICKS);
  });

  it('une seconde ouverture remplace les participants de la premiere', () => {
    const portal = new Portal();
    portal.open(0, [1, 2]);
    portal.step(portal.deadlineTick);

    portal.open(1000, [3]);
    expect(portal.setVote(1, LEAVE)).toBe(false);
    expect(portal.setVote(3, LEAVE)).toBe(true);
    expect(portal.step(1001)).toBe(LEAVE);
  });
});
