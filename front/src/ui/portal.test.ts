// @vitest-environment jsdom
import { EXTRACT_MULTIPLIER_STEP, TICK_HZ } from '@shared/constants';
import { extractGold } from '@shared/paliers';
import { NO_VOTE, VOTE_CHOICE } from '@shared/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, ce qui
// verifie le CABLAGE et pas seulement la classe qui ecrit dedans.
import indexHtml from '../../index.html?raw';
import {
  formatGold,
  formatMultiplier,
  leaveGold,
  PortalScreen,
  type PortalSource,
  stakeLines,
  stayGold,
  THIN_SPACE,
  voteLabel,
  voteState,
} from './portal';

/**
 * L'ecran du vote d'extraction se teste sous jsdom : tout ce qu'on exige de lui
 * est OBSERVABLE dans le DOM — le vote de chaque autre joueur, l'abstention
 * DISTINCTE d'un vote « rester », les deux montants d'or, le chronometre
 * derive du tick, et le choix envoye au serveur.
 */

/**
 * Le client d'epreuve.
 *
 * ⚠️ **Aucun champ de points de vie** : tout joueur connecte vote, mort ou
 * vif, donc l'ecran n'a rien a filtrer.
 */
class FakeClient implements PortalSource {
  localId: number | null = 2;
  hordeTick = 0;
  portalOpen = false;
  portalDeadlineTick = 0;
  portalMultiplier = 1;
  portalVotes: ReadonlyMap<number, number> = new Map();
  portalDecision: number | null = null;
  portalGold = 0;
  gold = 0;
  /** Ce qui est parti sur le fil — la seule chose que l'ecran envoie. */
  readonly sent: number[] = [];

  castVote(choice: number): void {
    this.sent.push(choice);
  }

  /** Simule un `VOTES` : `GameClient` remplace la `Map` a chaque message. */
  votes(pairs: readonly [number, number][]): void {
    this.portalVotes = new Map(pairs);
  }
}

interface Harness {
  root: HTMLElement;
  status: HTMLElement;
  stakes: HTMLElement;
  choices: HTMLElement;
  voters: HTMLElement;
  client: FakeClient;
  screen: PortalScreen;
}

/**
 * ⚠️ **Des nombres qui ne ressemblent a rien du jeu** (ni `PORTAL_WINDOW_TICKS`,
 * ni `GOLD_PER_PALIER_BASE`, ni un multiple) : une fixture egale a une
 * constante de production laisse passer une derivation fausse.
 */
const TICK = 4_017;
const ECHEANCE = TICK + 7 * TICK_HZ + 4;
const CAGNOTTE = 8_413;
const MULTIPLICATEUR = 1.75;

function harness(): Harness {
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'portal';
  root.className = 'hidden';
  const status = document.createElement('p');
  const stakes = document.createElement('div');
  const choices = document.createElement('div');
  const voters = document.createElement('div');
  root.append(status, stakes, choices, voters);
  document.body.append(root);
  const client = new FakeClient();
  return {
    root,
    status,
    stakes,
    choices,
    voters,
    client,
    screen: new PortalScreen(root, status, stakes, choices, voters, client),
  };
}

/**
 * Un portail REELLEMENT ouvert : sur un ecran ferme, `update` revient avant
 * d'ecrire quoi que ce soit, et tout scenario passerait tout seul.
 */
function ouvert(h: Harness): void {
  h.client.portalOpen = true;
  h.client.hordeTick = TICK;
  h.client.portalDeadlineTick = ECHEANCE;
  h.client.portalMultiplier = MULTIPLICATEUR;
  h.client.gold = CAGNOTTE;
}

function boutons(h: Harness): HTMLButtonElement[] {
  return [...h.choices.querySelectorAll('button')];
}

function boutonDe(h: Harness, choix: number): HTMLButtonElement {
  const found = boutons(h).find((b) => b.dataset.choice === voteState(choix));
  if (!found) {
    throw new Error(`aucun bouton pour le choix ${choix}`);
  }
  return found;
}

/** Les votants affiches, dans l'ordre affiche : identifiant, etat, mot. */
function votants(h: Harness): { id: string; choice: string; label: string }[] {
  return [...h.voters.querySelectorAll('.portal-voter')].map((n) => {
    const el = n as HTMLElement;
    return {
      id: el.dataset.player ?? '',
      choice: el.dataset.choice ?? '',
      label: el.querySelector('.portal-voter__label')?.textContent ?? '',
    };
  });
}

function stakeText(h: Harness, which: 'leave' | 'stay'): string {
  return h.stakes.querySelector(`[data-stake="${which}"]`)?.textContent ?? '';
}

describe('le cablage vers index.html', () => {
  it('trouve les cinq elements que main.ts va chercher', () => {
    // `el()` dans `main.ts` LEVE quand un identifiant manque : renommer l'un
    // d'eux casse le demarrage du jeu entier, pas seulement le vote. Rien
    // d'autre dans la chaine (`typecheck`, `build`) ne relit ce fichier.
    for (const id of [
      'portal',
      'portal-status',
      'portal-stakes',
      'portal-choices',
      'portal-voters',
    ]) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
  });

  /**
   * ⚠️ **Le vote n'est PAS un modale.** Le draft gele le monde, donc `#draft`
   * peut prendre `inset-0` ; le vote ne gele rien, et un voile plein ecran
   * cacherait la horde qui avance pendant qu'on negocie.
   */
  it('pose le vote en bandeau, jamais en voile plein ecran comme le draft', () => {
    document.body.innerHTML = indexHtml;
    const portal = document.getElementById('portal');
    const draft = document.getElementById('draft');

    expect(draft?.className).toContain('inset-0');
    expect(portal?.className).not.toContain('inset-0');
    // Et le pointeur ne revient qu'aux boutons : le reste du bandeau ne doit
    // pas voler un clic destine au jeu.
    expect(portal?.className).toContain('pointer-events-none');
    expect(document.getElementById('portal-choices')?.className).toContain('pointer-events-auto');
  });
});

describe('formatGold — un montant qui se lit pendant une vague', () => {
  it('groupe par milliers, avec un separateur choisi et pas celui d Intl', () => {
    expect(formatGold(1_234_567)).toBe(`1${THIN_SPACE}234${THIN_SPACE}567`);
    expect(formatGold(999)).toBe('999');
    expect(formatGold(1_000)).toBe(`1${THIN_SPACE}000`);
  });

  it('rend un zero, jamais du vide', () => {
    expect(formatGold(0)).toBe('0');
  });
});

describe('formatMultiplier — la progression de la mise', () => {
  /** ⚠️ **Deux decimales TOUJOURS, meme sur 1** : voir `formatMultiplier`. */
  it('ecrit deux decimales et une virgule, meme sur un entier', () => {
    expect(formatMultiplier(1)).toBe('×1,00');
    expect(formatMultiplier(1.25)).toBe('×1,25');
    expect(formatMultiplier(2.5)).toBe('×2,50');
  });
});

describe('voteLabel — l abstention est un etat A PART', () => {
  /** ⚠️ **« n'a pas voté » ne doit JAMAIS se lire comme « reste »** : voir `voteLabel`. */
  it('donne trois mots DIFFERENTS aux trois etats', () => {
    const mots = [voteLabel(VOTE_CHOICE.LEAVE), voteLabel(VOTE_CHOICE.STAY), voteLabel(NO_VOTE)];

    expect(new Set(mots).size).toBe(3);
    expect(voteLabel(VOTE_CHOICE.LEAVE)).toBe('part');
    expect(voteLabel(VOTE_CHOICE.STAY)).toBe('reste');
    expect(voteLabel(NO_VOTE)).toBe("n'a pas voté");
  });

  it('traite tout octet inconnu comme une abstention, jamais comme une voix', () => {
    // L'ecran depend du fil, pas de ce que `back/src/portal.ts` emet
    // aujourd'hui : un `7` fantaisiste n'est pas davantage une voix.
    expect(voteLabel(7)).toBe(voteLabel(NO_VOTE));
    expect(voteState(7)).toBe('none');
  });
});

describe("les deux chiffres de l'enjeu", () => {
  /**
   * ⚠️ **Passe par `extractGold`, la fonction que le SALON appelle** : l'ecran
   * annonce le montant que le joueur recevra.
   */
  it('ce qu on gagne en partant : la cagnotte majoree du multiplicateur COURANT', () => {
    expect(leaveGold(CAGNOTTE, MULTIPLICATEUR)).toBe(extractGold(CAGNOTTE, MULTIPLICATEUR));
    // Et la majoration se VOIT : sans elle, ce serait la cagnotte nue.
    expect(leaveGold(CAGNOTTE, MULTIPLICATEUR)).toBeGreaterThan(CAGNOTTE);
  });

  /**
   * ⚠️ **Le multiplicateur suivant se DERIVE de la constante partagee** : sans
   * le pas, les deux montants seraient egaux.
   */
  it('ce qu on vise en restant : la meme cagnotte, au multiplicateur SUIVANT', () => {
    expect(stayGold(CAGNOTTE, MULTIPLICATEUR)).toBe(
      extractGold(CAGNOTTE, MULTIPLICATEUR + EXTRACT_MULTIPLIER_STEP),
    );
    expect(stayGold(CAGNOTTE, MULTIPLICATEUR)).toBeGreaterThan(leaveGold(CAGNOTTE, MULTIPLICATEUR));
  });

  it('dit AUSSI que tout se perd, parce que le chiffre seul ne le dit pas', () => {
    // L'effacement de l'equipe fait tout perdre : « 12 000 au prochain
    // portail » seul ne montrerait que la moitie positive de la decision.
    expect(stakeLines(CAGNOTTE, MULTIPLICATEUR).stay).toMatch(/perdu/i);
  });
});

describe('PortalScreen — ce que le joueur voit', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('reste efface tant qu aucun portail n est ouvert', () => {
    h.screen.update();

    expect(h.root.classList.contains('hidden')).toBe(true);
    expect(boutons(h)).toHaveLength(0);
  });

  it('s affiche des que le portail est ouvert', () => {
    ouvert(h);
    h.screen.update();

    expect(h.root.classList.contains('hidden')).toBe(false);
    expect(h.root.classList.contains('flex')).toBe(true);
    expect(boutons(h)).toHaveLength(2);
  });

  /**
   * ⚠️ **DERIVE DU TICK, jamais de l'horloge murale.** Le decor place
   * l'echeance a 7 secondes et 4 ticks : un chronometre qui diviserait par la
   * mauvaise cadence afficherait un nombre plausible et faux.
   */
  it('decompte les secondes a partir du TICK de horde', () => {
    ouvert(h);
    h.screen.update();
    expect(h.status.textContent).toBe('Le portail est ouvert — 8 s');

    // Cinq secondes de simulation plus tard, et RIEN d'autre n'a bouge.
    h.client.hordeTick = TICK + 5 * TICK_HZ;
    h.screen.update();
    expect(h.status.textContent).toBe('Le portail est ouvert — 3 s');
  });

  it('ne descend jamais sous zero, meme apres l echeance', () => {
    ouvert(h);
    h.client.hordeTick = ECHEANCE + 3 * TICK_HZ;
    h.screen.update();

    expect(h.status.textContent).toBe('Le portail est ouvert — 0 s');
  });

  it('affiche les DEUX montants, et ils sont differents', () => {
    ouvert(h);
    h.screen.update();

    const partir = stakeText(h, 'leave');
    const rester = stakeText(h, 'stay');
    expect(partir).toContain(formatGold(extractGold(CAGNOTTE, MULTIPLICATEUR)));
    expect(partir).toContain(formatMultiplier(MULTIPLICATEUR));
    expect(rester).toContain(
      formatGold(extractGold(CAGNOTTE, MULTIPLICATEUR + EXTRACT_MULTIPLIER_STEP)),
    );
    expect(rester).toContain(formatMultiplier(MULTIPLICATEUR + EXTRACT_MULTIPLIER_STEP));
    expect(partir).not.toBe(rester);
  });

  /**
   * ⚠️ **L'or vient du SNAPSHOT, donc il bouge PENDANT la fenetre** : figer le
   * montant a l'ouverture mentirait des le tick suivant. Le multiplicateur,
   * annonce une fois, ne bouge pas.
   */
  it('suit l or du snapshot d une image a l autre', () => {
    ouvert(h);
    h.screen.update();
    expect(stakeText(h, 'leave')).toContain(formatGold(extractGold(CAGNOTTE, MULTIPLICATEUR)));

    h.client.gold = CAGNOTTE + 2_500;
    h.screen.update();
    expect(stakeText(h, 'leave')).toContain(
      formatGold(extractGold(CAGNOTTE + 2_500, MULTIPLICATEUR)),
    );
  });

  /**
   * ⚠️ **La visibilite est la mecanique** : on ne negocie pas un choix qu'on ne
   * voit pas.
   *
   * ⚠️ **Le decor porte les TROIS etats a la fois** : avec deux seulement, un
   * ecran qui confondrait l'abstention avec « rester » passerait.
   */
  it('montre le vote de CHAQUE joueur, abstention comprise et DISTINCTE', () => {
    ouvert(h);
    h.client.votes([
      [3, VOTE_CHOICE.STAY],
      [1, VOTE_CHOICE.LEAVE],
      [4, NO_VOTE],
    ]);
    h.screen.update();

    expect(votants(h)).toEqual([
      { id: '1', choice: 'leave', label: 'part' },
      { id: '3', choice: 'stay', label: 'reste' },
      { id: '4', choice: 'none', label: "n'a pas voté" },
    ]);
  });

  /**
   * ⚠️ **Tri par identifiant** : l'ordre d'iteration d'une `Map` suit l'ordre
   * d'arrivee des messages, donc la latence — les votants sauteraient de place
   * a chaque rafraichissement. Le decor arrive volontairement dans le desordre.
   */
  it('range les votants par identifiant, pas par ordre d arrivee', () => {
    ouvert(h);
    h.client.votes([
      [4, VOTE_CHOICE.STAY],
      [2, VOTE_CHOICE.STAY],
      [1, VOTE_CHOICE.STAY],
      [3, VOTE_CHOICE.STAY],
    ]);
    h.screen.update();

    expect(votants(h).map((v) => v.id)).toEqual(['1', '2', '3', '4']);
  });

  it('distingue MON vote de celui des autres', () => {
    ouvert(h);
    h.client.votes([
      [1, VOTE_CHOICE.LEAVE],
      [2, VOTE_CHOICE.STAY],
    ]);
    h.screen.update();

    const locaux = [...h.voters.querySelectorAll('.portal-voter')].map(
      (n) => (n as HTMLElement).dataset.local,
    );
    expect(locaux).toEqual(['false', 'true']);
  });

  /**
   * ⚠️ **L'ecran ne se cache PAS pour un joueur mort** : tout joueur connecte
   * vote, mort ou vif. Ce test verrouille la SURFACE — un filtre de vie
   * demanderait d'ajouter un champ a `PortalSource`, et se verrait ici.
   */
  it('reste affiche pour un joueur qui n est plus dans le salon vivant', () => {
    ouvert(h);
    h.client.votes([[2, VOTE_CHOICE.LEAVE]]);
    h.screen.update();

    expect(h.root.classList.contains('hidden')).toBe(false);
    expect(votants(h)).toHaveLength(1);
  });

  it('envoie le choix clique, sans rien afficher de facon optimiste', () => {
    // ⚠️ Le client PROPOSE, le serveur arbitre : un vote affiche des le clic
    // mentirait a chaque refus.
    ouvert(h);
    h.screen.update();

    boutonDe(h, VOTE_CHOICE.LEAVE).click();

    expect(h.client.sent).toEqual([VOTE_CHOICE.LEAVE]);
    expect(votants(h)).toEqual([]);
  });

  it('envoie aussi RESTER — les deux faces, pas seulement celle qui saute aux yeux', () => {
    ouvert(h);
    h.screen.update();

    boutonDe(h, VOTE_CHOICE.STAY).click();

    expect(h.client.sent).toEqual([VOTE_CHOICE.STAY]);
  });

  /**
   * ⚠️ **Le vote est REVOCABLE**, comme le jeton du draft : une voix qu'on ne
   * pourrait plus reprendre ferait de la negociation une course au clic.
   */
  it('recliquer la face qu on a deja choisie RETIRE la voix', () => {
    ouvert(h);
    h.client.votes([[2, VOTE_CHOICE.STAY]]);
    h.screen.update();

    boutonDe(h, VOTE_CHOICE.STAY).click();

    expect(h.client.sent).toEqual([NO_VOTE]);
  });

  it('cliquer l AUTRE face change la voix au lieu de la retirer', () => {
    // La moitie negative du test precedent : sans elle, un ecran qui enverrait
    // toujours `NO_VOTE` passerait.
    ouvert(h);
    h.client.votes([[2, VOTE_CHOICE.STAY]]);
    h.screen.update();

    boutonDe(h, VOTE_CHOICE.LEAVE).click();

    expect(h.client.sent).toEqual([VOTE_CHOICE.LEAVE]);
  });

  it('marque la face que le SERVEUR dit que j ai choisie', () => {
    ouvert(h);
    h.client.votes([
      [1, VOTE_CHOICE.LEAVE],
      [2, VOTE_CHOICE.STAY],
    ]);
    h.screen.update();

    expect(boutonDe(h, VOTE_CHOICE.STAY).dataset.mine).toBe('true');
    // ⚠️ Le vote d'un AUTRE ne marque pas ma face : sans cette moitie, un ecran
    // qui marquerait toute face votee par quiconque passerait.
    expect(boutonDe(h, VOTE_CHOICE.LEAVE).dataset.mine).toBe('false');
  });

  it('affiche le verdict PARTIR avec l or acquis, et ferme les deux faces', () => {
    ouvert(h);
    h.screen.update();
    h.client.portalDecision = VOTE_CHOICE.LEAVE;
    h.client.portalGold = 14_723;
    h.screen.update();

    expect(h.status.textContent).toBe(`L'équipe part — 14${THIN_SPACE}723 or acquis.`);
    expect(h.root.dataset.settled).toBe('true');
    expect(boutons(h).map((b) => b.disabled)).toEqual([true, true]);
  });

  it('affiche le verdict RESTER avec l or toujours en jeu', () => {
    // ⚠️ Les DEUX verdicts : `PORTAL_RESULT` porte un seul champ d'or dont le
    // sens se lit dans la decision. Un ecran qui ne lirait qu'un des deux
    // afficherait « acquis » sur une cagnotte encore risquee.
    ouvert(h);
    h.screen.update();
    h.client.portalDecision = VOTE_CHOICE.STAY;
    h.client.portalGold = 14_723;
    h.screen.update();

    expect(h.status.textContent).toBe(`L'équipe reste — 14${THIN_SPACE}723 or toujours en jeu.`);
  });

  it('disparait quand le client ferme le vote', () => {
    ouvert(h);
    h.screen.update();
    expect(h.root.classList.contains('hidden')).toBe(false);

    // C'est `GameClient.portalOpen` qui bascule, au TICK D'EFFET du verdict —
    // jamais l'ecran, qui ne decide rien.
    h.client.portalOpen = false;
    h.screen.update();

    expect(h.root.classList.contains('hidden')).toBe(true);
    expect(h.root.classList.contains('flex')).toBe(false);
  });

  it('ne construit ses deux faces qu une fois, quel que soit le nombre d images', () => {
    ouvert(h);
    h.screen.update();
    const premier = boutonDe(h, VOTE_CHOICE.LEAVE);
    h.screen.update();
    h.screen.update();

    expect(boutons(h)).toHaveLength(2);
    // Meme noeud : une reconstruction par image perdrait le focus clavier et
    // relancerait toute animation CSS a chaque image.
    expect(boutonDe(h, VOTE_CHOICE.LEAVE)).toBe(premier);
  });
});
