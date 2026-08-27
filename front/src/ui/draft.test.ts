// @vitest-environment jsdom
import { CARD, type Card } from '@shared/cards';
import { TICK_HZ } from '@shared/constants';
import { NO_TOKEN, OUTCOME } from '@shared/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, sans que le
// test ait a deviner un chemin sur le disque (`import.meta.url` n'est pas une
// URL `file:` sous jsdom).
import indexHtml from '../../index.html?raw';
import { type DraftOutcomeView, DraftScreen, type DraftSource, remainingSeconds } from './draft';

/**
 * L'ecran de draft se teste sous jsdom, et pas « ca n'a pas plante » : ce que
 * la spec exige de lui est OBSERVABLE dans le DOM — le jeton d'un autre joueur
 * sur la carte qu'il vise (§7.2 point 3), la carte qui brule chez le perdant
 * pendant qu'elle s'illumine chez le gagnant (§4.2), et l'indice envoye au
 * serveur quand on clique.
 */

class FakeClient implements DraftSource {
  localId: number | null = 1;
  hordeTick = 0;
  draftCards: readonly Card[] = [];
  draftDeadlineTick = 0;
  draftIntents: ReadonlyMap<number, number> = new Map();
  draftOutcomes: readonly DraftOutcomeView[] = [];
  draftSettled = false;
  isFrozen = false;
  /** Ce qui est parti sur le fil — c'est la seule chose que l'ecran envoie. */
  readonly sent: number[] = [];

  placeToken(cardIndex: number): void {
    this.sent.push(cardIndex);
  }

  /** Simule un `DRAFT_INTENTS` : `GameClient` remplace la `Map` a chaque message. */
  intents(pairs: readonly [number, number][]): void {
    this.draftIntents = new Map(pairs);
  }

  /** Simule un `DRAFT_RESULT` : `GameClient` decode un tableau NEUF a chaque message. */
  result(outcomes: DraftOutcomeView[], phase: 0 | 1): void {
    this.draftOutcomes = outcomes;
    this.draftIntents = new Map();
    if (phase === 0) {
      this.draftSettled = true;
      this.isFrozen = true;
    }
  }
}

interface Harness {
  root: HTMLElement;
  status: HTMLElement;
  list: HTMLElement;
  client: FakeClient;
  screen: DraftScreen;
}

function harness(): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'draft';
  root.className = 'hidden';
  const status = document.createElement('p');
  const list = document.createElement('div');
  root.append(status, list);
  document.body.append(root);
  const client = new FakeClient();
  return { root, status, list, client, screen: new DraftScreen(root, status, list, client) };
}

/** Un etalage lisible : trois cartes ouvertes, une reservee au joueur 2. */
function spread(): Card[] {
  return [
    { nature: CARD.NEW_WEAPON, refId: 1, owner: 0 }, // eventail
    { nature: CARD.PASSIVE, refId: 1, owner: 0 }, // cadence
    { nature: CARD.NEW_WEAPON, refId: 3, owner: 0 }, // lance-flammes
    { nature: CARD.WEAPON_LEVEL, refId: 2, owner: 2 }, // arc-lourd, joueur 2 seul
  ];
}

function cards(h: Harness): HTMLButtonElement[] {
  return [...h.list.querySelectorAll('button')];
}

function statesOf(h: Harness): string[] {
  return cards(h).map((c) => c.dataset.state ?? '');
}

/** Les identifiants des jetons poses sur la carte `index`, dans l'ordre affiche. */
function tokensOn(h: Harness, index: number): string[] {
  const cell = cards(h)[index];
  return [...(cell?.querySelectorAll('.draft-token') ?? [])].map(
    (t) => (t as HTMLElement).dataset.player ?? '',
  );
}

describe('le cablage vers index.html', () => {
  it('trouve les trois elements que main.ts va chercher', () => {
    // `el()` dans `main.ts` LEVE quand un identifiant manque : renommer le
    // conteneur casse le demarrage du jeu entier, pas seulement le draft. Rien
    // d'autre dans la chaine (`typecheck`, `build`) ne relit ce fichier.
    for (const id of ['draft', 'draft-status', 'draft-cards']) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
  });
});

describe('remainingSeconds', () => {
  it('arrondit au-dessus et ne descend jamais sous zero', () => {
    expect(remainingSeconds(100 + 5 * TICK_HZ, 100)).toBe(5);
    // Une fraction de seconde restante s'affiche « 1 s », pas « 0 s ».
    expect(remainingSeconds(101, 100)).toBe(1);
    expect(remainingSeconds(100, 100)).toBe(0);
    // Une echeance depassee (le message de fermeture n'est pas encore arrive)
    // afficherait un compte a rebours negatif sans le plancher.
    expect(remainingSeconds(100, 250)).toBe(0);
  });
});

describe("DraftScreen — l'etalage", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
  });

  it('reste cache tant qu aucun draft n est ouvert', () => {
    h.screen.update();
    expect(h.root.classList.contains('hidden')).toBe(true);
    expect(cards(h)).toHaveLength(0);
  });

  it('dessine une carte par carte de l etalage, avec sa nature et son nom', () => {
    h.client.draftCards = spread();
    h.screen.update();

    expect(h.root.classList.contains('hidden')).toBe(false);
    expect(cards(h)).toHaveLength(4);
    expect(cards(h).map((c) => c.querySelector('.draft-card__name')?.textContent)).toEqual([
      'eventail',
      'cadence',
      'lance-flammes',
      'arc-lourd',
    ]);
    // La nature n'est pas decorative : elle dit si `refId` indexe les armes ou
    // les passifs, et lire la mauvaise table donne un nom plausible et faux.
    expect(cards(h).map((c) => c.querySelector('.draft-card__nature')?.textContent)).toEqual([
      'Arme',
      'Passif',
      'Arme',
      'Niveau',
    ]);
    expect(cards(h).map((c) => c.dataset.index)).toEqual(['0', '1', '2', '3']);
  });

  it('reconstruit l etalage au draft suivant, et pas avant', () => {
    h.client.draftCards = spread();
    h.screen.update();
    const premiere = cards(h)[0];
    h.screen.update();
    expect(cards(h)[0]).toBe(premiere);

    h.client.draftCards = [{ nature: CARD.PASSIVE, refId: 0, owner: 0 }];
    h.screen.update();
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]?.querySelector('.draft-card__name')?.textContent).toBe('vitalite');
  });

  it('affiche le chronometre de la fenetre, puis celui de la repioche', () => {
    h.client.draftCards = spread();
    h.client.hordeTick = 300;
    h.client.draftDeadlineTick = 300 + 20 * TICK_HZ;
    h.screen.update();
    expect(h.status.textContent).toBe('Posez votre jeton — 20 s');

    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.LOST }], 1);
    h.client.draftDeadlineTick = 300 + 5 * TICK_HZ;
    h.screen.update();
    expect(h.status.textContent).toBe('Repioche — 5 s');
  });
});

describe("DraftScreen — les jetons (§7.2 point 3 : sans eux, la mecanique n'existe pas)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.client.draftCards = spread();
  });

  it('pose le jeton d un autre joueur sur la carte qu il vise, et sur elle seule', () => {
    h.client.intents([[3, 2]]);
    h.screen.update();

    expect(tokensOn(h, 2)).toEqual(['3']);
    expect(tokensOn(h, 0)).toEqual([]);
    expect(tokensOn(h, 1)).toEqual([]);
    expect(tokensOn(h, 3)).toEqual([]);
  });

  it('empile plusieurs jetons sur une carte convoitee, tries par joueur', () => {
    // Ordre d'insertion volontairement inverse : l'ordre d'iteration d'une
    // `Map` suit l'ordre d'ARRIVEE des messages, donc la latence — les jetons
    // sauteraient de place a chaque rafraichissement.
    h.client.intents([
      [4, 1],
      [2, 1],
      [3, 0],
    ]);
    h.screen.update();

    expect(tokensOn(h, 1)).toEqual(['2', '4']);
    expect(tokensOn(h, 0)).toEqual(['3']);
  });

  it('distingue mon jeton de celui des autres', () => {
    h.client.intents([
      [1, 0],
      [2, 0],
    ]);
    h.screen.update();

    const locaux = [...(cards(h)[0]?.querySelectorAll('.draft-token') ?? [])].map(
      (t) => (t as HTMLElement).dataset.local,
    );
    expect(locaux).toEqual(['true', 'false']);
    expect(cards(h)[0]?.dataset.mine).toBe('true');
    expect(cards(h)[1]?.dataset.mine).toBe('false');
  });

  it('deplace le jeton quand l intention change', () => {
    h.client.intents([[2, 0]]);
    h.screen.update();
    h.client.intents([[2, 3]]);
    h.screen.update();

    expect(tokensOn(h, 0)).toEqual([]);
    expect(tokensOn(h, 3)).toEqual(['2']);
  });
});

describe('DraftScreen — le geste (§4.1 : poser un jeton EST la selection)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.client.draftCards = spread();
    h.screen.update();
  });

  it('envoie l indice de LA carte cliquee', () => {
    cards(h)[2]?.click();
    expect(h.client.sent).toEqual([2]);

    cards(h)[0]?.click();
    expect(h.client.sent).toEqual([2, 0]);
  });

  it('recliquer la carte ou mon jeton est deja pose le retire', () => {
    h.client.intents([[1, 1]]);
    h.screen.update();

    cards(h)[1]?.click();
    expect(h.client.sent).toEqual([NO_TOKEN]);

    // Une AUTRE carte reste un deplacement, jamais un retrait.
    cards(h)[2]?.click();
    expect(h.client.sent).toEqual([NO_TOKEN, 2]);
  });

  it('n envoie rien pour une carte reservee a un autre joueur (§3.2)', () => {
    expect(cards(h)[3]?.dataset.state).toBe('locked');
    expect(cards(h)[3]?.disabled).toBe(true);
    cards(h)[3]?.click();
    expect(h.client.sent).toEqual([]);
  });

  it('offre la carte reservee a son seul eligible', () => {
    h.client.localId = 2;
    h.screen.update();
    expect(cards(h)[3]?.dataset.state).toBe('idle');
    cards(h)[3]?.click();
    expect(h.client.sent).toEqual([3]);
  });
});

describe('DraftScreen — la revelation (§4.2)', () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.client.draftCards = spread();
    h.screen.update();
  });

  it('illumine ma carte et consume celle que j ai perdue, la meme carte chez chacun', () => {
    // Joueurs 1 et 3 visaient la carte 2 ; c'est le 3 qui l'emporte.
    h.client.result(
      [
        { playerId: 3, cardIndex: 2, outcome: OUTCOME.WON },
        { playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST },
      ],
      1,
    );
    h.screen.update();

    // Chez MOI (joueur 1) elle brule. « lost » n'est pas « pas gagnee » : la
    // carte 0, que personne n'a touchee, reste `idle`, et la carte 1, prise par
    // un autre sans que je la vise, est `taken`.
    expect(statesOf(h)[2]).toBe('lost');

    // Le meme etat vu du gagnant : la MEME carte, illuminee.
    const chezLeGagnant = harness();
    chezLeGagnant.client.localId = 3;
    chezLeGagnant.client.draftCards = spread();
    chezLeGagnant.screen.update();
    chezLeGagnant.client.result(
      [
        { playerId: 3, cardIndex: 2, outcome: OUTCOME.WON },
        { playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST },
      ],
      1,
    );
    chezLeGagnant.screen.update();
    expect(statesOf(chezLeGagnant)[2]).toBe('won');
  });

  it('distingue « prise par un autre » de « perdue par moi »', () => {
    h.client.result(
      [
        { playerId: 2, cardIndex: 1, outcome: OUTCOME.WON },
        { playerId: 3, cardIndex: 0, outcome: OUTCOME.AUTO },
        { playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST },
        { playerId: 4, cardIndex: 2, outcome: OUTCOME.WON },
      ],
      1,
    );
    h.screen.update();

    expect(statesOf(h)).toEqual(['taken', 'taken', 'lost', 'locked']);
  });

  it('ne considere pas comme prise une carte qu un autre a seulement PERDUE', () => {
    // ⚠️ **Etat que `Draft#resolve` ne produit pas aujourd'hui** : il emet
    // toujours exactement un `WON` par carte contestee, donc un `LOST` y
    // cotoie toujours un gagnant, et la mutation « `else` sans condition »
    // survit a tout test de bout en bout (motif R8/R10 du registre).
    //
    // L'ecran, lui, est une fonction de ce qui arrive sur le fil. Ce test
    // enonce SON contrat, pas une observation du serveur — et le §4.4 de la
    // spec, qui veut une attribution d'office pour les perdants d'un
    // reconflit, rendra cet etat atteignable le jour ou il sera respecte.
    h.client.result([{ playerId: 2, cardIndex: 1, outcome: OUTCOME.LOST }], 1);
    h.screen.update();
    expect(statesOf(h)[1]).toBe('idle');
    expect(cards(h)[1]?.disabled).toBe(false);
  });

  it("l attribution d office s illumine comme une victoire : c'est une carte obtenue", () => {
    h.client.result([{ playerId: 1, cardIndex: 1, outcome: OUTCOME.AUTO }], 0);
    h.screen.update();
    expect(statesOf(h)[1]).toBe('won');
    expect(h.status.textContent).toBe('Vous obtenez : cadence');
  });

  it('garde la carte du gagnant du premier tour illuminee jusqu a la fin', () => {
    // Le `DRAFT_RESULT` de la repioche ne parle QUE des perdants : sans cumul,
    // la carte du gagnant s'eteindrait au moment meme ou elle doit confirmer.
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }], 1);
    h.screen.update();
    expect(statesOf(h)[0]).toBe('won');

    h.client.result([{ playerId: 2, cardIndex: 1, outcome: OUTCOME.WON }], 0);
    h.screen.update();
    expect(statesOf(h)[0]).toBe('won');
    expect(statesOf(h)[1]).toBe('taken');
    expect(h.status.textContent).toBe('Vous obtenez : eventail');
  });

  it('montre au perdant ce qu il perd ET ce qu il obtient a la place', () => {
    h.client.result(
      [
        { playerId: 2, cardIndex: 0, outcome: OUTCOME.WON },
        { playerId: 1, cardIndex: 0, outcome: OUTCOME.LOST },
      ],
      1,
    );
    h.screen.update();
    expect(statesOf(h)[0]).toBe('lost');
    // Pendant la repioche, je reste le seul a devoir choisir.
    expect(cards(h)[2]?.disabled).toBe(false);

    h.client.result([{ playerId: 1, cardIndex: 2, outcome: OUTCOME.WON }], 0);
    h.screen.update();
    expect(statesOf(h)[0]).toBe('lost');
    expect(statesOf(h)[2]).toBe('won');
    expect(h.status.textContent).toBe('Vous obtenez : lance-flammes');
  });

  it('le gagnant du premier tour ne repose pas de jeton a la repioche', () => {
    h.client.result(
      [
        { playerId: 1, cardIndex: 0, outcome: OUTCOME.WON },
        { playerId: 2, cardIndex: 1, outcome: OUTCOME.WON },
        { playerId: 3, cardIndex: 1, outcome: OUTCOME.LOST },
      ],
      1,
    );
    h.screen.update();

    expect(cards(h)[2]?.disabled).toBe(true);
    cards(h)[2]?.click();
    expect(h.client.sent).toEqual([]);
    expect(h.status.textContent).toMatch(/les autres choisissent/);
  });

  it('dit qu il n y a rien quand la resolution ne m attribue aucune carte', () => {
    // Un perdant de reconflit a la repioche : `Draft#resolve` lui rend `LOST`
    // sans attribution de repli. Un ecran muet le laisserait croire a un bug.
    h.client.result([{ playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST }], 0);
    h.screen.update();
    expect(h.status.textContent).toBe('Rien cette fois.');
  });

  it('remet les issues a zero au draft suivant', () => {
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }], 0);
    h.screen.update();
    expect(statesOf(h)[0]).toBe('won');

    h.client.draftCards = spread();
    h.client.draftOutcomes = [];
    h.client.draftSettled = false;
    h.screen.update();
    expect(statesOf(h)).toEqual(['idle', 'idle', 'idle', 'locked']);
    expect(h.status.textContent).toMatch(/Posez votre jeton/);
  });
});

describe("DraftScreen — quand l'ecran s'arrete de dessiner (F2)", () => {
  let h: Harness;
  beforeEach(() => {
    h = harness();
    h.client.draftCards = spread();
    h.screen.update();
  });

  it('tient l etalage pendant toute la rampe de reprise, puis disparait', () => {
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }], 0);
    h.screen.update();
    // L'etalage SURVIT a la fermeture (`draftSettled` ne veut pas dire « il
    // n'y a plus rien a montrer ») : c'est ce qui rend la revelation dessinable.
    expect(h.root.classList.contains('hidden')).toBe(false);
    expect(h.root.dataset.settled).toBe('true');

    // Fin de la rampe : le monde a repris, l'ecran se retire — sans attendre
    // un `DRAFT_OPEN` qui ne viendra qu'au niveau suivant.
    h.client.isFrozen = false;
    h.screen.update();
    expect(h.root.classList.contains('hidden')).toBe(true);
  });

  it('ne se retire pas pendant la repioche, ou le gel court toujours', () => {
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.LOST }], 1);
    h.client.isFrozen = false; // pas encore observable : le gel n'a pas de fin connue
    h.screen.update();
    expect(h.root.classList.contains('hidden')).toBe(false);
    expect(h.root.dataset.settled).toBe('false');
  });
});

describe('le jeton du tour precedent ne survit pas a l etalage suivant', () => {
  it('la carte reprise au niveau suivant se selectionne, elle ne se desselectionne pas', () => {
    // ⚠️ **Defaut signale par l'auteur en jouant, mot pour mot** : « si je
    // selectionne un passif "Passif 1" et qu'au niveau suivant il est encore
    // la, j'ai deja mon jeton "1" dessus et je peux pas le reprendre ».
    //
    // Deux defauts s'y composaient. Cote serveur, `Draft` gardait ses jetons
    // apres la fermeture et `Session#broadcast` les rediffusait a chaque tick.
    // Cote client, `DRAFT_OPEN` ne vidait pas la `Map` des intentions. Le
    // joueur voyait donc son jeton du tour precedent deja pose — et comme le
    // §4.1 fait du reclic un RETRAIT, cliquer la carte qu'il voulait envoyait
    // `NO_TOKEN` au lieu de son indice.
    //
    // Le cas est COURANT et pas tordu : les passifs ne sont jamais exclus de
    // l'etalage (§3.4), donc celui qu'on vient de prendre revient au tour
    // suivant.
    const h = harness();

    // Premier tour : je pose sur la carte 1 et je la gagne.
    h.client.draftCards = spread();
    h.screen.update();
    cards(h)[1]?.click();
    expect(h.client.sent).toEqual([1]);
    h.client.intents([[1, 1]]);
    h.screen.update();
    expect(tokensOn(h, 1)).toEqual(['1']);

    h.client.result([{ playerId: 1, cardIndex: 1, outcome: OUTCOME.WON }], 0);
    h.screen.update();

    // Second tour : un etalage NEUF, qui contient la meme carte au meme indice.
    h.client.draftCards = spread();
    h.client.draftSettled = false;
    h.client.isFrozen = true;
    h.client.draftOutcomes = [];
    h.screen.update();

    // Plus aucun jeton nulle part : personne n'a encore pose.
    expect(tokensOn(h, 1)).toEqual([]);

    // Et le clic POSE, il ne retire pas.
    h.client.sent.length = 0;
    cards(h)[1]?.click();
    expect(h.client.sent).toEqual([1]);
    expect(h.client.sent).not.toContain(NO_TOKEN);
  });
});
