// @vitest-environment jsdom
import { CARD, type Card } from '@shared/cards';
import { PASSIVE_SLOTS, TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import { ELEMENT, ELEMENTS, elementOf } from '@shared/elements';
import { Loadout } from '@shared/loadout';
import { PASSIVES, passiveOf } from '@shared/passives';
import { NO_TOKEN, OUTCOME } from '@shared/protocol';
import { WEAPONS, weaponOf } from '@shared/weapons';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, sans que le
// test ait a deviner un chemin sur le disque (`import.meta.url` n'est pas une
// URL `file:` sous jsdom).
import indexHtml from '../../index.html?raw';
import {
  blockedReason,
  cardDetail,
  cssColor,
  type DraftOutcomeView,
  DraftScreen,
  type DraftSource,
  magnitudeLabel,
  remainingSeconds,
} from './draft';

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
  /** Absent par defaut, comme chez les doubles qui n'ont pas de miroir d'inventaire. */
  loadoutOf?(playerId: number): Loadout;
  /** Ce qui est parti sur le fil — c'est la seule chose que l'ecran envoie. */
  readonly sent: number[] = [];

  placeToken(cardIndex: number): void {
    this.sent.push(cardIndex);
  }

  /** Simule un `DRAFT_INTENTS` : `GameClient` remplace la `Map` a chaque message. */
  intents(pairs: readonly [number, number][]): void {
    this.draftIntents = new Map(pairs);
  }

  /**
   * Simule un `DRAFT_RESULT` : `GameClient` decode un tableau NEUF a chaque
   * message.
   *
   * ⚠️ **Plus de parametre `phase`.** La repioche a disparu : le message est
   * emis EXACTEMENT une fois par draft, et il ferme toujours la negociation.
   */
  result(outcomes: DraftOutcomeView[]): void {
    this.draftOutcomes = outcomes;
    this.draftIntents = new Map();
    this.draftSettled = true;
    this.isFrozen = true;
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
  return {
    root,
    status,
    list,
    client,
    screen: new DraftScreen(root, status, list, client),
  };
}

/**
 * Un etalage lisible : quatre cartes, toutes OUVERTES A TOUS.
 *
 * ⚠️ **Plus aucune carte n'est reservee.** `owner` a disparu avec les montees
 * de niveau : l'eligibilite se derive de l'inventaire cote serveur, et l'ecran
 * n'a plus d'etat `locked` a peindre a l'ouverture.
 */
function spread(): Card[] {
  return [
    { nature: CARD.WEAPON, refId: 1 }, // eventail
    { nature: CARD.PASSIVE, refId: 1 }, // cadence
    { nature: CARD.WEAPON, refId: 3 }, // lance-flammes
    { nature: CARD.WEAPON, refId: 2 }, // arc-lourd
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

/** La meme teinte, telle que jsdom rend une couleur posee en ligne. */
function rgbOf(tint: number): string {
  return `rgb(${(tint >> 16) & 255}, ${(tint >> 8) & 255}, ${tint & 255})`;
}

/**
 * La teinte d'un element telle que `cardDetail` doit l'ecrire.
 *
 * ⚠️ **Composee ici composante par composante**, et pas avec le
 * `toString(16).padStart(6)` de la production : recopier la formule testee
 * rendrait sa mutation invisible. Et la teinte elle-meme est LUE dans
 * `ELEMENTS` — l'ecrire « #ff7a3c » en dur ferait diverger la carte et le sol
 * a la premiere retouche de palette, sans que rien ne rougisse.
 */
function hexOf(tint: number): string {
  return `#${[16, 8, 0].map((d) => ((tint >> d) & 255).toString(16).padStart(2, '0')).join('')}`;
}

describe('cardDetail — ce que la carte dit en plus de son nom (tache 19)', () => {
  it("nomme l'element d'une arme elementaire, a la teinte de cet element", () => {
    // ⚠️ **Tout le sujet du §6.5.** « eventail » ne dit pas si l'arme sert la
    // Braise ou le Givre, donc ne dit pas si elle complete ce qu'un allie vient
    // de prendre — et c'est cette lecture-la que l'etalage existe pour
    // permettre.
    const braise = WEAPONS.find((w) => w.element === ELEMENT.BRAISE);
    if (!braise) {
      throw new Error('fixture : aucune arme de Braise au catalogue');
    }
    const detail = cardDetail({ nature: CARD.WEAPON, refId: braise.id });

    expect(detail.text).toBe(elementOf(ELEMENT.BRAISE).name);
    expect(detail.color).toBe(hexOf(elementOf(ELEMENT.BRAISE).tint));
    // Le format, en plus de la valeur : une couleur CSS, pas un nombre.
    expect(detail.color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('distingue le Givre de la Braise, jusque dans la teinte', () => {
    // Deux elements differents doivent rendre deux details differents : un
    // `cardDetail` qui rendrait toujours le premier element de la table
    // passerait le test precedent tout seul.
    const givre = WEAPONS.find((w) => w.element === ELEMENT.GIVRE);
    if (!givre) {
      throw new Error('fixture : aucune arme de Givre au catalogue');
    }
    const detail = cardDetail({ nature: CARD.WEAPON, refId: givre.id });

    expect(detail.text).toBe(elementOf(ELEMENT.GIVRE).name);
    expect(detail.text).not.toBe(elementOf(ELEMENT.BRAISE).name);
    expect(detail.color).toBe(hexOf(elementOf(ELEMENT.GIVRE).tint));
  });

  it('fait lire une arme NEUTRE comme neutre, pas comme une carte incomplete', () => {
    // ⚠️ Cinq armes du catalogue sur neuf sont neutres et le restent. Un detail
    // vide sur celles-la se lirait comme une information manquante, pas comme
    // le socle voulu par le §6.3 de l'orientation.
    const neutre = WEAPONS.find((w) => w.element === ELEMENT.NEUTRE);
    if (!neutre) {
      throw new Error('fixture : aucune arme neutre au catalogue');
    }
    const detail = cardDetail({ nature: CARD.WEAPON, refId: neutre.id });

    expect(detail.text).toBe(elementOf(ELEMENT.NEUTRE).name);
    expect(detail.text.length).toBeGreaterThan(0);
  });

  it('donne un element a CHAQUE arme du catalogue, teinte comprise', () => {
    // Garde du garde : les trois tests ci-dessus ne couvrent que trois armes.
    for (const w of WEAPONS) {
      const detail = cardDetail({ nature: CARD.WEAPON, refId: w.id });
      expect(detail.text).toBe(elementOf(w.element).name);
      expect(detail.color).toBe(hexOf(elementOf(w.element).tint));
    }
  });

  it('porte la valeur du passif, avec son unite, et sans teinte a poser', () => {
    const vitalite = PASSIVES.find((p) => p.kind === 'maxHp');
    if (!vitalite) {
      throw new Error('fixture : aucun passif de points de vie au catalogue');
    }

    expect(cardDetail({ nature: CARD.PASSIVE, refId: vitalite.id })).toEqual({
      // La magnitude est LUE, l'unite est pinglee : c'est le libelle qui est
      // une decision d'ecran, pas le nombre.
      text: `+${vitalite.magnitude} PV max`,
      color: null,
    });
  });

  it('lit la BONNE table : la nature decide, pas le refId', () => {
    // `refId` indexe `WEAPONS` ou `PASSIVES` selon la nature, et le meme indice
    // existe des deux cotes : un `cardDetail` qui lirait toujours les armes
    // rendrait un element plausible sur une carte de passif.
    const detail = cardDetail({ nature: CARD.PASSIVE, refId: 1 });

    expect(detail.text).toBe(magnitudeLabel(passiveOf(1)));
    expect(detail.text).not.toBe(elementOf(weaponOf(1).element).name);
  });
});

describe('cssColor — une teinte sombre reste une couleur CSS', () => {
  it('remplit a six chiffres, meme quand la composante rouge est nulle', () => {
    // ⚠️ **Aucune teinte du catalogue n'exerce ce remplissage** — les trois
    // commencent par un chiffre non nul — et la mutation qui le retire
    // survivait a toute la suite. `0x00aabb` s'ecrirait « #aabb », que le
    // navigateur ignore : la carte perdrait sa couleur, silencieusement, le
    // jour ou un element sombre entre au catalogue.
    expect(cssColor(0x00aabb)).toBe('#00aabb');
    expect(cssColor(0x000000)).toBe('#000000');
  });

  it('rend les teintes du catalogue telles quelles', () => {
    for (const e of ELEMENTS) {
      expect(cssColor(e.tint)).toBe(hexOf(e.tint));
    }
  });
});

describe('magnitudeLabel — une valeur sans unite ne veut rien dire', () => {
  /**
   * ⚠️ **Les cinq genres, chacun avec SON unite.** Les magnitudes du
   * catalogue sont heterogenes par construction : `maxHp` en points bruts (20),
   * `speed` en pixels par seconde (15), `regen` en points PAR SECONDE (2),
   * `fireRate` et `damage` en FRACTIONS (0,08 et 0,10). Les afficher toutes de
   * la meme facon laisserait croire que « vitalite » vaut deux cents fois
   * « cadence », et que « regain » rend deux points une fois pour toutes.
   */
  it.each([
    ['maxHp', ' PV max'],
    ['speed', ' px/s'],
    ['damage', ' % dégâts'],
    ['fireRate', ' % recharge'],
    // ⚠️ **La seule unite de DEBIT du catalogue** (etape 6a, tache 17) :
    // « regain » rend des points de vie par SECONDE, pas une fois pour toutes.
    // L'ecrire « +2 PV » en ferait un doublon de « vitalite ».
    ['regen', ' PV/s'],
  ] as const)('finit %s par son unite', (kind, unite) => {
    const passive = PASSIVES.find((p) => p.kind === kind);
    if (!passive) {
      throw new Error(`fixture : aucun passif de genre ${kind}`);
    }
    expect(magnitudeLabel(passive).endsWith(unite)).toBe(true);
  });

  it('lit la magnitude du CATALOGUE : deux passifs du meme genre ne disent pas la meme chose', () => {
    // ⚠️ **C'est ce qui tue « le nombre est ecrit en dur ».** « puissance »
    // (0,10) et « acier » (0,06) sont tous deux du genre `damage` : leur unite
    // est la meme, leur valeur non. Un libelle constant passerait tous les
    // tests d'unite ci-dessus.
    const memeGenre = PASSIVES.filter((p) => p.kind === 'damage');
    expect(memeGenre.length).toBeGreaterThan(1);
    expect(new Set(memeGenre.map((p) => p.magnitude)).size).toBe(memeGenre.length);

    expect(new Set(memeGenre.map(magnitudeLabel)).size).toBe(memeGenre.length);
  });

  it('dit le SENS du bonus : la cadence RETIRE de la recharge, tout le reste ajoute', () => {
    // `cooldownWithBonus` retire une fraction de la recharge — l'ecrire « +8 % »
    // dirait le contraire de ce que le nombre fait.
    for (const p of PASSIVES) {
      expect(magnitudeLabel(p).startsWith(p.kind === 'fireRate' ? '−' : '+')).toBe(true);
    }
  });

  it('arrondit les fractions au lieu d afficher dix-sept chiffres', () => {
    // `0.08 * 100` peut valoir 8.000000000000002 en virgule flottante.
    for (const p of PASSIVES) {
      expect(magnitudeLabel(p)).not.toMatch(/\d{6}/);
    }
  });

  it('donne une etiquette a CHAQUE passif du catalogue', () => {
    // Garde du garde : ajouter un `PassiveKind` sans unite rendrait `undefined`
    // sur la carte, et le draft afficherait un trou.
    for (const p of PASSIVES) {
      expect(magnitudeLabel(p)).toMatch(/^[+−]\d/);
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
      'Éventail',
      'cadence',
      'Lance-flammes',
      'Arc lourd',
    ]);
    // La nature n'est pas decorative : elle dit si `refId` indexe les armes ou
    // les passifs, et lire la mauvaise table donne un nom plausible et faux.
    expect(cards(h).map((c) => c.querySelector('.draft-card__nature')?.textContent)).toEqual([
      'Arme',
      'Passif',
      'Arme',
      'Arme',
    ]);
    expect(cards(h).map((c) => c.dataset.index)).toEqual(['0', '1', '2', '3']);
  });

  /**
   * ⚠️ **Tache 19 : c'est ici que meurt la mutation « le detail n'est pas
   * attache ».** `cardDetail` est gardee de son cote ; le fait de l'appeler et
   * d'accrocher son resultat a la carte ne l'est que par cette assertion —
   * c'est la distinction qui a coute trois etapes a ce depot.
   */
  it("porte l'element des armes et la valeur des passifs, a l'ecran", () => {
    h.client.draftCards = spread();
    h.screen.update();

    expect(cards(h).map((c) => c.querySelector('.draft-card__detail')?.textContent)).toEqual(
      spread().map((card) => cardDetail(card).text),
    );
    // L'etalage d'epreuve contient bien les deux natures ET les deux lectures :
    // sans ca, la ligne ci-dessus pourrait ne verifier qu'un seul chemin.
    expect(new Set(spread().map((c) => c.nature)).size).toBe(2);
  });

  it("teinte le detail d'une arme a la couleur de son element, et laisse un passif sans teinte", () => {
    // La teinte est ce qui fait le lien entre la carte et ce qu'on verra au sol
    // en tirant : c'est la meme que celle de l'anneau de marque et de la zone.
    h.client.draftCards = [
      { nature: CARD.WEAPON, refId: 1 },
      { nature: CARD.PASSIVE, refId: 1 },
    ];
    h.screen.update();

    const arme = cards(h)[0]?.querySelector('.draft-card__detail') as HTMLElement | null;
    const passif = cards(h)[1]?.querySelector('.draft-card__detail') as HTMLElement | null;
    expect(arme?.style.color).toBe(rgbOf(elementOf(weaponOf(1).element).tint));
    // Rien en ligne : la carte garde sa couleur d'ambre.
    expect(passif?.style.color).toBe('');
  });

  it('reconstruit l etalage au draft suivant, et pas avant', () => {
    h.client.draftCards = spread();
    h.screen.update();
    const premiere = cards(h)[0];
    h.screen.update();
    expect(cards(h)[0]).toBe(premiere);

    h.client.draftCards = [{ nature: CARD.PASSIVE, refId: 0 }];
    h.screen.update();
    expect(cards(h)).toHaveLength(1);
    expect(cards(h)[0]?.querySelector('.draft-card__name')?.textContent).toBe('vitalite');
  });

  it('affiche le chronometre de la fenetre, decompte compris', () => {
    h.client.draftCards = spread();
    h.client.hordeTick = 300;
    h.client.draftDeadlineTick = 300 + 20 * TICK_HZ;
    h.screen.update();
    expect(h.status.textContent).toBe('Posez votre jeton — 20 s');

    // Le temps passe : c'est bien `hordeTick` qui est lu, pas une constante.
    h.client.hordeTick = 300 + 12 * TICK_HZ;
    h.screen.update();
    expect(h.status.textContent).toBe('Posez votre jeton — 8 s');
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

  it('envoie l indice d une carte qu un AUTRE vise deja : c est ca, la negociation', () => {
    // ⚠️ **Aucune carte ne se verrouille plus.** Le §7.2 point 3 veut qu'on
    // puisse poser son jeton sur la carte que quelqu'un d'autre convoite —
    // sans ca il n'y a pas de negociation, seulement une course au clic. Un
    // ecran qui desactiverait la carte deja visee rendrait tout conflit
    // impossible depuis l'interface, quoi que le serveur accepte.
    h.client.intents([[3, 2]]);
    h.screen.update();
    expect(tokensOn(h, 2)).toEqual(['3']);
    expect(cards(h)[2]?.dataset.state).toBe('idle');
    expect(cards(h)[2]?.disabled).toBe(false);

    cards(h)[2]?.click();
    expect(h.client.sent).toEqual([2]);
  });

  it('offre les quatre cartes a tout le monde, quel que soit le joueur local', () => {
    for (const id of [1, 2, 3, 4]) {
      const autre = harness();
      autre.client.localId = id;
      autre.client.draftCards = spread();
      autre.screen.update();
      expect(statesOf(autre)).toEqual(['idle', 'idle', 'idle', 'idle']);
      expect(cards(autre).map((c) => c.disabled)).toEqual([false, false, false, false]);
    }
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
    h.client.result([
      { playerId: 3, cardIndex: 2, outcome: OUTCOME.WON },
      { playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST },
    ]);
    h.screen.update();

    // Chez MOI (joueur 1) elle brule. « lost » n'est pas « pas gagnee » : la
    // carte 0, que personne n'a touchee, reste `idle`.
    expect(statesOf(h)[2]).toBe('lost');
    expect(statesOf(h)[0]).toBe('idle');

    // Le meme etat vu du gagnant : la MEME carte, illuminee.
    const chezLeGagnant = harness();
    chezLeGagnant.client.localId = 3;
    chezLeGagnant.client.draftCards = spread();
    chezLeGagnant.screen.update();
    chezLeGagnant.client.result([
      { playerId: 3, cardIndex: 2, outcome: OUTCOME.WON },
      { playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST },
    ]);
    chezLeGagnant.screen.update();
    expect(statesOf(chezLeGagnant)[2]).toBe('won');
  });

  it('distingue « prise par un autre » de « perdue par moi »', () => {
    h.client.result([
      { playerId: 2, cardIndex: 1, outcome: OUTCOME.WON },
      { playerId: 3, cardIndex: 0, outcome: OUTCOME.AUTO },
      { playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST },
      { playerId: 4, cardIndex: 2, outcome: OUTCOME.WON },
    ]);
    h.screen.update();

    expect(statesOf(h)).toEqual(['taken', 'taken', 'lost', 'idle']);
  });

  it('ne considere pas comme prise une carte qu un autre a seulement PERDUE', () => {
    // ⚠️ **Etat que `Draft#resolve` ne produit pas aujourd'hui** : il emet
    // toujours exactement un `WON` par carte contestee, donc un `LOST` y
    // cotoie toujours un gagnant, et la mutation « `else` sans condition »
    // survit a tout test de bout en bout (motif R8/R10 du registre).
    //
    // L'ecran, lui, est une fonction de ce qui arrive sur le fil. Ce test
    // enonce SON contrat, pas une observation du serveur.
    h.client.result([{ playerId: 2, cardIndex: 1, outcome: OUTCOME.LOST }]);
    h.screen.update();
    expect(statesOf(h)[1]).toBe('idle');
  });

  it("l attribution d office s illumine comme une victoire : c'est une carte obtenue", () => {
    h.client.result([{ playerId: 1, cardIndex: 1, outcome: OUTCOME.AUTO }]);
    h.screen.update();
    expect(statesOf(h)[1]).toBe('won');
    expect(h.status.textContent).toBe('Vous obtenez : cadence');
  });

  it('montre au perdant ce qu il perd ET ce qu il obtient a la place, DANS LE MEME LOT', () => {
    // ⚠️ **Le point de bascule du modele, vu de l'ecran.** Il y avait ici
    // DEUX `DRAFT_RESULT` : celui du conflit, puis celui de la repioche. Le
    // perdant ne rechoisit plus — *« ca brule la carte si je l'ai pas eu et ca
    // en illumine une autre »* — donc les deux issues arrivent ensemble, et
    // l'ecran doit peindre les deux etats d'un seul coup.
    //
    // ⚠️ Un ecran qui ne regarderait que la PREMIERE issue d'un joueur
    // s'arreterait au `LOST` et n'illuminerait rien. On exige donc les deux
    // etats a la fois, et le statut qui nomme la carte de remplacement.
    h.client.result([
      { playerId: 2, cardIndex: 0, outcome: OUTCOME.WON },
      { playerId: 1, cardIndex: 0, outcome: OUTCOME.LOST },
      { playerId: 1, cardIndex: 2, outcome: OUTCOME.AUTO },
    ]);
    h.screen.update();

    expect(statesOf(h)[0]).toBe('lost');
    expect(statesOf(h)[2]).toBe('won');
    expect(h.status.textContent).toBe('Vous obtenez : Lance-flammes');
  });

  it('dit qu il n y a rien quand la resolution ne m attribue aucune carte', () => {
    // Cas limite reel : l'etalage epuise, `Draft#step` ne trouve plus de carte
    // libre a donner au perdant et son lot ne porte que son `LOST`. Un ecran
    // muet le laisserait croire a un bug.
    h.client.result([{ playerId: 1, cardIndex: 2, outcome: OUTCOME.LOST }]);
    h.screen.update();
    expect(h.status.textContent).toBe('Rien cette fois.');
  });

  it('n accepte plus aucun clic une fois la negociation close', () => {
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]);
    h.screen.update();
    expect(cards(h).every((c) => c.disabled)).toBe(true);
    cards(h)[2]?.click();
    expect(h.client.sent).toEqual([]);
  });

  it('remet les issues a zero au draft suivant', () => {
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]);
    h.screen.update();
    expect(statesOf(h)[0]).toBe('won');

    h.client.draftCards = spread();
    h.client.draftOutcomes = [];
    h.client.draftSettled = false;
    h.screen.update();
    expect(statesOf(h)).toEqual(['idle', 'idle', 'idle', 'idle']);
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
    h.client.result([{ playerId: 1, cardIndex: 0, outcome: OUTCOME.WON }]);
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

    h.client.result([{ playerId: 1, cardIndex: 1, outcome: OUTCOME.WON }]);
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

/** Un inventaire aux slots d'armes pleins : Dague, Eventail, Grenade, Chakram. */
function fullWeapons(): Loadout {
  const loadout = new Loadout();
  for (const id of [0, 1, 4, 5].slice(0, WEAPON_SLOTS)) {
    loadout.addWeapon(id);
  }
  return loadout;
}

describe('une carte que mon inventaire refuse', () => {
  function blockedHarness(loadout: Loadout): Harness {
    const h = harness();
    h.client.loadoutOf = () => loadout;
    h.client.draftCards = spread();
    h.screen.update();
    return h;
  }

  it('bloque une arme NOUVELLE quand les slots sont pleins : desactivee, raison affichee, clic sans effet', () => {
    const h = blockedHarness(fullWeapons());
    const lance = cards(h)[2];
    expect(lance?.dataset.blocked).toBe('true');
    expect(lance?.disabled).toBe(true);
    const banner = lance?.querySelector('.draft-card__blocked');
    expect(banner?.textContent).toContain(
      `Arsenal complet — ${WEAPON_SLOTS}/${WEAPON_SLOTS} armes`,
    );
    expect(banner?.textContent).toContain(weaponOf(0).name);
    lance?.click();
    expect(h.client.sent).toEqual([]);
  });

  it('garde visibles les jetons des autres sur une carte bloquee pour moi', () => {
    const h = blockedHarness(fullWeapons());
    h.client.intents([[2, 2]]);
    h.screen.update();
    expect(tokensOn(h, 2)).toEqual(['2']);
  });

  it("ne bloque jamais une arme deja possedee : elle s'empile", () => {
    const h = blockedHarness(fullWeapons());
    const eventail = cards(h)[0];
    expect(eventail?.dataset.blocked).toBe('false');
    expect(eventail?.disabled).toBe(false);
    expect(eventail?.querySelector('.draft-card__blocked')).toBeNull();
    eventail?.click();
    expect(h.client.sent).toEqual([0]);
  });

  it('bloque un passif NOUVEAU quand les slots de passifs sont pleins', () => {
    const loadout = new Loadout();
    // Tous sauf `cadence` (refId 1, celui de l'etalage).
    for (const id of [0, 2, 3, 4].slice(0, PASSIVE_SLOTS)) {
      loadout.addPassive(id);
    }
    const h = blockedHarness(loadout);
    const cadence = cards(h)[1];
    expect(cadence?.disabled).toBe(true);
    const banner = cadence?.querySelector('.draft-card__blocked');
    expect(banner?.textContent).toContain(`Passifs complets — ${PASSIVE_SLOTS}/${PASSIVE_SLOTS}`);
    expect(banner?.textContent).toContain(passiveOf(0).name);
    cadence?.click();
    expect(h.client.sent).toEqual([]);
    // Les armes, elles, rentrent encore.
    expect(cards(h)[2]?.disabled).toBe(false);
  });

  it("ne bloque rien sans miroir d'inventaire", () => {
    const h = harness();
    h.client.draftCards = spread();
    h.screen.update();
    for (const card of cards(h)) {
      expect(card.dataset.blocked).toBe('false');
      expect(card.disabled).toBe(false);
    }
  });

  it('dit, en tete, que rien ne rentrera quand TOUTES les cartes sont bloquees', () => {
    const loadout = fullWeapons();
    for (const id of [0, 2, 3, 4].slice(0, PASSIVE_SLOTS)) {
      loadout.addPassive(id);
    }
    const h = harness();
    h.client.loadoutOf = () => loadout;
    // Que des cartes refusees : deux armes nouvelles et un passif nouveau.
    h.client.draftCards = [spread()[1], spread()[2], spread()[3]] as Card[];
    h.screen.update();
    expect(h.status.textContent).toContain('Rien ne rentre dans votre inventaire');
  });

  it("garde l'invite habituelle tant qu'une carte au moins rentre", () => {
    const h = blockedHarness(fullWeapons());
    expect(h.status.textContent).toContain('Posez votre jeton');
  });

  it('blockedReason rend null pour une carte prenable', () => {
    expect(blockedReason({ nature: CARD.WEAPON, refId: 3 }, new Loadout())).toBeNull();
  });
});
