// @vitest-environment jsdom
import { SYNERGY_MAX } from '@shared/constants';
import { Loadout } from '@shared/loadout';
import { PASSIVES, passiveOf } from '@shared/passives';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, meme motif
// que `draft.test.ts` — c'est ce qui permet de verifier le CABLAGE vers
// `index.html` et pas seulement la fonction qui ecrit dedans.
import indexHtml from '../../index.html?raw';
import type { HudInfo } from '../render/stage';
import {
  type HudElements,
  type HudSource,
  paintHud,
  paintPassives,
  paintSynergy,
  passiveRows,
  synergyRatio,
} from './hud';

/**
 * Étape 5a, §9 : *« la barre de Synergie : une jauge dans le HUD, visible de
 * tous »*.
 *
 * Testee sous jsdom parce que c'est la SEULE partie du rendu de cette tache
 * qui soit reellement observable sans navigateur : le reste passe par des
 * `ParticleContainer` dont les textures exigent un canevas 2D que jsdom ne
 * fournit pas (voir `zone-renderer.test.ts`).
 */

interface Harness {
  fill: HTMLElement;
  label: HTMLElement;
}

function mount(): Harness {
  document.body.innerHTML = indexHtml;
  const fill = document.getElementById('hud-synergy-fill');
  const label = document.getElementById('hud-synergy-label');
  if (!fill || !label) {
    throw new Error('la jauge de Synergie est absente de index.html');
  }
  return { fill, label };
}

describe('le cablage vers index.html', () => {
  it('trouve les deux elements que main.ts va chercher', () => {
    document.body.innerHTML = indexHtml;

    // Meme garde que celle de `draft.test.ts` : `main.ts` fait
    // `await stage.init()` au niveau module et n'est pas importable en test,
    // donc rien d'autre ne verifie que ces identifiants existent encore. Un
    // renommage dans le HTML ferait planter le jeu au demarrage (`el()` leve),
    // sans qu'aucune suite ne rougisse.
    expect(document.getElementById('hud-synergy-fill')).not.toBeNull();
    expect(document.getElementById('hud-synergy-label')).not.toBeNull();
    // Tache 18 : le cadre de la colonne des passifs, et ses lignes.
    expect(document.getElementById('hud-passives')).not.toBeNull();
    expect(document.getElementById('hud-passive-list')).not.toBeNull();
  });
});

describe('synergyRatio — la part remplie de la barre', () => {
  it('vaut 0 barre vide et 1 barre pleine', () => {
    expect(synergyRatio(0)).toBe(0);
    expect(synergyRatio(SYNERGY_MAX)).toBe(1);
  });

  it('monte proportionnellement entre les deux', () => {
    expect(synergyRatio(SYNERGY_MAX / 2)).toBeCloseTo(0.5, 6);
  });

  it('ne deborde jamais du cadre, meme au-dela du plafond', () => {
    // Le serveur plafonne deja (tache 8) ; un serveur plus recent, dont le
    // plafond aurait ete releve, ne doit pas faire deborder la barre d'un
    // client plus ancien.
    expect(synergyRatio(SYNERGY_MAX * 3)).toBe(1);
  });
});

describe('paintSynergy — ce que le joueur voit', () => {
  let dom: Harness;

  beforeEach(() => {
    dom = mount();
  });

  /**
   * ⚠️ **Les deux extremes, dans le meme fichier** (R24/R25) : « la jauge ne
   * se remplit jamais » et « la jauge est toujours pleine » se ressemblent
   * beaucoup dans un test qui n'en verifierait qu'un. En solo la barre ne
   * monte JAMAIS (§7), donc une jauge cassee a 0 % passerait inapercue en
   * partie solo — c'est exactement le cas ou il faut que le test parle.
   */
  it('ne remplit rien quand la barre est vide', () => {
    paintSynergy(dom.fill, dom.label, 0);

    expect(dom.fill.style.width).toBe('0%');
    expect(dom.label.textContent).toBe(`0 / ${SYNERGY_MAX}`);
  });

  it('remplit tout quand la barre est pleine', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX);

    expect(dom.fill.style.width).toBe('100%');
    expect(dom.label.textContent).toBe(`${SYNERGY_MAX} / ${SYNERGY_MAX}`);
  });

  it('remplit a moitie a mi-course — la barre BOUGE, elle ne saute pas de vide a pleine', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX / 2);

    expect(dom.fill.style.width).toBe('50%');
  });

  it('affiche le compte en clair, pas seulement la barre', () => {
    // Une barre qui glisse de trois pixels ne dit pas ce qui l'a fait monter ;
    // un « 3 / 20 » qui change juste apres un flash blanc, si. C'est le §6.5
    // — la Synergie est *le coeur du projet*, elle doit se lire.
    paintSynergy(dom.fill, dom.label, 3);

    expect(dom.label.textContent).toBe(`3 / ${SYNERGY_MAX}`);
  });

  it('repeint a chaque appel, sans garder la valeur precedente', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX);
    paintSynergy(dom.fill, dom.label, 0);

    expect(dom.fill.style.width).toBe('0%');
    expect(dom.label.textContent).toBe(`0 / ${SYNERGY_MAX}`);
  });
});

/**
 * Tache 9 bis : le HUD entier, monte sur le vrai `index.html`.
 *
 * ⚠️ **C'est ici que meurt la mutation « `paintSynergy` retiree ».** Avant
 * cette suite, l'appel vivait dans `main.ts` : la fonction etait gardee, le
 * fait de l'appeler ne l'etait pas. La distinction n'est pas theorique — trois
 * etapes de suite ont perdu une ligne de cablage exactement comme ca.
 */
function hudElements(): HudElements {
  document.body.innerHTML = indexHtml;
  const pick = (id: string): HTMLElement => {
    const node = document.getElementById(id);
    if (!node) {
      throw new Error(`#${id} absent de index.html`);
    }
    return node;
  };
  return {
    hp: pick('hud-hp'),
    level: pick('hud-level'),
    timer: pick('hud-timer'),
    lateDeaths: pick('hud-late-deaths'),
    synergyFill: pick('hud-synergy-fill'),
    synergyLabel: pick('hud-synergy-label'),
    freeze: pick('hud-freeze'),
    passives: pick('hud-passives'),
    passiveList: pick('hud-passive-list'),
  };
}

const INFO: HudInfo = { hp: 73, xp: 500, level: 4, timer: '2:07', frozen: false };

/**
 * Le client d'epreuve de la tache 18 : un identifiant local, et un inventaire
 * par joueur — la meme surface que `GameClient`, dont `loadoutOf` cree
 * l'entree manquante a la volee.
 */
class FakeSource implements HudSource {
  localId: number | null = 1;
  readonly loadouts = new Map<number, Loadout>();

  loadoutOf(playerId: number): Loadout {
    const found = this.loadouts.get(playerId);
    if (found) {
      return found;
    }
    const fresh = new Loadout();
    this.loadouts.set(playerId, fresh);
    return fresh;
  }

  /** Prend `n` fois la carte de passif `id` pour le joueur `playerId`. */
  prend(id: number, n = 1, playerId = 1): this {
    const inv = this.loadoutOf(playerId);
    for (let i = 0; i < n; i++) {
      inv.addPassive(id);
    }
    return this;
  }
}

/** Les identifiants du catalogue, nommes — jamais recopies en dur dans une assertion. */
const VITALITE = 0;
const CADENCE = 1;
const FOUGUE = 3;

describe('passiveRows — ce que la colonne a a dire', () => {
  it('ne dit rien tant que rien n est drafte', () => {
    expect(passiveRows(new FakeSource())).toEqual([]);
  });

  it('rend une ligne par passif POSSEDE, avec son nombre d exemplaires', () => {
    // ⚠️ Le coeur de la tache : deux passifs pris un nombre DIFFERENT de fois.
    // Une colonne qui rendrait « 1 » partout, ou le nombre de passifs distincts,
    // passerait un test ou les deux comptes seraient egaux.
    const source = new FakeSource().prend(VITALITE, 4).prend(CADENCE, 1);

    expect(passiveRows(source)).toEqual([
      { name: passiveOf(VITALITE).name, stacks: 4 },
      { name: passiveOf(CADENCE).name, stacks: 1 },
    ]);
  });

  it('ignore les passifs que le joueur n a pas pris', () => {
    const source = new FakeSource().prend(FOUGUE, 2);

    expect(passiveRows(source).map((r) => r.name)).toEqual([passiveOf(FOUGUE).name]);
  });

  it('suit l ordre du CATALOGUE, pas l ordre d acquisition', () => {
    // Une colonne qui se reordonnerait a chaque carte prise devrait etre relue
    // en entier, pendant une vague. `fougue` est pris le premier et s'affiche
    // le dernier : c'est ce qui separe les deux ordres.
    const source = new FakeSource().prend(FOUGUE).prend(VITALITE);

    expect(passiveRows(source).map((r) => r.name)).toEqual([
      passiveOf(VITALITE).name,
      passiveOf(FOUGUE).name,
    ]);
  });

  it('ne lit que l inventaire du joueur LOCAL', () => {
    // Un `Loadout` par joueur, et la colonne est la MIENNE : afficher celle
    // d'un allie mentirait sur ce qu'on a construit.
    const source = new FakeSource().prend(VITALITE, 3, 2);

    expect(passiveRows(source)).toEqual([]);
  });

  it("n'invente aucun inventaire tant que le joueur local n'existe pas", () => {
    // ⚠️ `loadoutOf` CREE l'entree manquante : l'appeler avec un identifiant
    // invente garnirait la `Map` du client d'un joueur qui n'existe pas. Avant
    // le premier snapshot, `localId` est nul et la colonne est vide.
    const source = new FakeSource();
    source.localId = null;

    expect(passiveRows(source)).toEqual([]);
    expect(source.loadouts.size).toBe(0);
  });
});

describe('paintPassives — la colonne a l ecran', () => {
  let el: HudElements;
  beforeEach(() => {
    el = hudElements();
  });

  /** Le texte de chaque ligne de la colonne, dans l'ordre affiche. */
  const lignes = (): string[] =>
    [...el.passiveList.querySelectorAll('.hud-passive')].map((n) => n.textContent ?? '');

  it('efface le cadre tant qu il n y a rien a y mettre', () => {
    paintPassives(el.passives, el.passiveList, []);

    expect(el.passives.classList.contains('hidden')).toBe(true);
    expect(el.passives.classList.contains('flex')).toBe(false);
    expect(lignes()).toEqual([]);
  });

  it('montre le cadre des qu une carte est prise', () => {
    paintPassives(el.passives, el.passiveList, [{ name: 'vitalite', stacks: 1 }]);

    expect(el.passives.classList.contains('hidden')).toBe(false);
    expect(el.passives.classList.contains('flex')).toBe(true);
  });

  it('ecrit le nom ET le nombre d exemplaires', () => {
    // ⚠️ **Le nombre est la moitie du message.** Un passif pris quatre fois
    // n'est pas un passif pris une fois : c'est tout le modele Risk of Rain de
    // cette etape, et une colonne de noms seuls decrirait les deux builds de la
    // meme facon. Le « ×1 » se lit aussi : c'est lui qui devient « ×2 ».
    paintPassives(el.passives, el.passiveList, [
      { name: 'vitalite', stacks: 4 },
      { name: 'cadence', stacks: 1 },
    ]);

    expect(lignes()).toEqual(['vitalite ×4', 'cadence ×1']);
  });

  it('repeint a chaque appel, sans cumuler les lignes precedentes', () => {
    paintPassives(el.passives, el.passiveList, [{ name: 'vitalite', stacks: 1 }]);
    paintPassives(el.passives, el.passiveList, [{ name: 'vitalite', stacks: 2 }]);

    expect(lignes()).toEqual(['vitalite ×2']);
  });

  it('efface a nouveau le cadre si la colonne redevient vide', () => {
    paintPassives(el.passives, el.passiveList, [{ name: 'vitalite', stacks: 1 }]);
    paintPassives(el.passives, el.passiveList, []);

    expect(el.passives.classList.contains('hidden')).toBe(true);
    expect(el.passives.classList.contains('flex')).toBe(false);
  });

  it('n affiche jamais plus de lignes que le catalogue n a de passifs', () => {
    // Garde du garde : un `paintPassives` qui dupliquerait ses lignes ferait
    // une colonne plausible et fausse.
    const source = new FakeSource().prend(VITALITE, 2).prend(CADENCE, 5);
    paintPassives(el.passives, el.passiveList, passiveRows(source));

    expect(lignes().length).toBeLessThanOrEqual(PASSIVES.length);
    expect(lignes()).toEqual([`${passiveOf(VITALITE).name} ×2`, `${passiveOf(CADENCE).name} ×5`]);
  });
});

describe('paintHud — chaque case du HUD recoit son ecriture', () => {
  let el: HudElements;
  let source: FakeSource;

  beforeEach(() => {
    el = hudElements();
    source = new FakeSource();
  });

  it('ecrit les points de vie du joueur local', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.hp.textContent).toBe('73');
  });

  it('ecrit le niveau', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.level.textContent).toBe('4');
  });

  it('ecrit le chronometre, prefixe', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.timer.textContent).toBe('Temps 2:07');
  });

  it('ecrit le compteur de morts tardives — le chiffre de diagnostic du §2', () => {
    paintHud(el, INFO, 12, 0, source);
    expect(el.lateDeaths.textContent).toBe('12');
  });

  it('peint la jauge de Synergie', () => {
    paintHud(el, INFO, 0, SYNERGY_MAX / 2, source);
    expect(el.synergyFill.style.width).toBe('50%');
    expect(el.synergyLabel.textContent).toBe(`${SYNERGY_MAX / 2} / ${SYNERGY_MAX}`);
  });

  /**
   * ⚠️ **Tache 18 : c'est ici que meurt la mutation « la colonne n'est pas
   * peinte ».** `paintPassives` et `passiveRows` sont gardees chacune de leur
   * cote ; le fait de les APPELER ne l'est que par cette assertion — c'est la
   * distinction exacte qui a coute trois etapes a ce depot.
   */
  it('peint la colonne des passifs, du client jusqu au DOM', () => {
    source.prend(VITALITE, 4);
    paintHud(el, INFO, 0, 0, source);

    expect(el.passives.classList.contains('hidden')).toBe(false);
    expect([...el.passiveList.querySelectorAll('.hud-passive')].map((n) => n.textContent)).toEqual([
      `${passiveOf(VITALITE).name} ×4`,
    ]);
  });

  it('laisse la colonne effacee quand le joueur n a pris aucun passif', () => {
    paintHud(el, INFO, 0, 0, source);

    expect(el.passives.classList.contains('hidden')).toBe(true);
    expect(el.passiveList.querySelectorAll('.hud-passive')).toHaveLength(0);
  });

  /** Tache 24 : le gel de niveau, la dette non gardee de l'etape 3. */
  it('montre le bandeau de gel pendant le gel, et le cache sinon', () => {
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.classList.contains('hidden')).toBe(false);

    paintHud(el, { ...INFO, frozen: false }, 0, 0, source);
    expect(el.freeze.classList.contains('hidden')).toBe(true);
  });
});
