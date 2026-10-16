// @vitest-environment jsdom
import { SYNERGY_MAX, TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import { Loadout } from '@shared/loadout';
import { PASSIVES, passiveOf } from '@shared/passives';
import { beforeEach, describe, expect, it } from 'vitest';

// `?raw` de Vite : le HTML entre dans le bundle de test tel quel, meme motif
// que `draft.test.ts` — c'est ce qui permet de verifier le CABLAGE vers
// `index.html` et pas seulement la fonction qui ecrit dedans.
import indexHtml from '../../index.html?raw';
import type { HudInfo } from '../render/stage';
import {
  type AbilityElements,
  type HudElements,
  type HudSource,
  paintAbility,
  paintHud,
  paintPassives,
  paintSynergy,
  passiveRows,
  synergyRatio,
} from './hud';
import { THIN_SPACE } from './portal';

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
  it('trouve les cinq elements que main.ts va chercher', () => {
    document.body.innerHTML = indexHtml;

    // Meme garde que celle de `draft.test.ts` : `main.ts` fait
    // `await stage.init()` au niveau module et n'est pas importable en test,
    // donc rien d'autre ne verifie que ces identifiants existent encore. Un
    // renommage dans le HTML ferait planter le jeu au demarrage (`el()` leve),
    // sans qu'aucune suite ne rougisse.
    expect(document.getElementById('hud-synergy-fill')).not.toBeNull();
    expect(document.getElementById('hud-synergy-label')).not.toBeNull();
    // Tache 18 : les emplacements de passifs.
    expect(document.getElementById('hud-passive-list')).not.toBeNull();
    // Tache 10 de l'etape 6a : la cagnotte non securisee (§5).
    expect(document.getElementById('hud-gold')).not.toBeNull();
    // Etape 11 : le bandeau du porteur de coffre.
    expect(document.getElementById('hud-porteur')).not.toBeNull();
    // Etape 13 : la barre de bouclier, posee sur celle des PV.
    expect(document.getElementById('hud-shield')).not.toBeNull();
    expect(document.getElementById('hud-shield-fill')).not.toBeNull();
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

    expect(dom.fill.style.getPropertyValue('--v')).toBe('0');
    expect(dom.label.textContent).toBe(`0 / ${SYNERGY_MAX}`);
  });

  it('remplit tout quand la barre est pleine', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX);

    expect(dom.fill.style.getPropertyValue('--v')).toBe('1');
    expect(dom.label.textContent).toBe(`${SYNERGY_MAX} / ${SYNERGY_MAX}`);
  });

  it('remplit a moitie a mi-course — la barre BOUGE, elle ne saute pas de vide a pleine', () => {
    paintSynergy(dom.fill, dom.label, SYNERGY_MAX / 2);

    expect(dom.fill.style.getPropertyValue('--v')).toBe('0.5');
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

    expect(dom.fill.style.getPropertyValue('--v')).toBe('0');
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
    gold: pick('hud-gold'),
    freeze: pick('hud-freeze'),
    porteur: pick('hud-porteur'),
    passiveList: pick('hud-passive-list'),
    hpFill: pick('hud-hp-fill'),
    shield: pick('hud-shield'),
    shieldFill: pick('hud-shield-fill'),
    xpFill: pick('hud-xp-fill'),
    xpLabel: pick('hud-xp-label'),
    portrait: pick('hud-portrait') as HTMLImageElement,
    kills: pick('hud-kills'),
    weapons: pick('hud-weapons'),
  };
}

const INFO: HudInfo = {
  hp: 73,
  xp: 500,
  xpRatio: 0.25,
  xpNeeded: 2000,
  level: 4,
  timer: '2:07',
  frozen: false,
  shield: 0,
  shieldPool: 0,
};

/**
 * Le client d'epreuve de la tache 18 : un identifiant local, et un inventaire
 * par joueur — la meme surface que `GameClient`, dont `loadoutOf` cree
 * l'entree manquante a la volee.
 */
class FakeSource implements HudSource {
  localId: number | null = 1;
  localClassId: number | null = 1;
  /**
   * La cagnotte non securisee (tache 10).
   *
   * ⚠️ **Un nombre qui ne ressemble a rien du jeu** : ni `GOLD_PER_PALIER_BASE`
   * (100), ni un multiple, ni un total de palier. Une fixture egale a une
   * constante de production rend la tache invérifiable — dix fois dans ce
   * depot.
   */
  gold = 0;
  /** PV max : 146, sans rapport avec `PLAYER_MAX_HP` (meme doctrine que `gold`). */
  localMaxHp = 146;
  kills = 0;
  draftIsChest = false;
  porteurBannerOn = false;
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
      { name: passiveOf(VITALITE).label, kind: passiveOf(VITALITE).kind, stacks: 4 },
      { name: passiveOf(CADENCE).label, kind: passiveOf(CADENCE).kind, stacks: 1 },
    ]);
  });

  it('ignore les passifs que le joueur n a pas pris', () => {
    const source = new FakeSource().prend(FOUGUE, 2);

    expect(passiveRows(source).map((r) => r.name)).toEqual([passiveOf(FOUGUE).label]);
  });

  it('suit l ordre du CATALOGUE, pas l ordre d acquisition', () => {
    // Une colonne qui se reordonnerait a chaque carte prise devrait etre relue
    // en entier, pendant une vague. `fougue` est pris le premier et s'affiche
    // le dernier : c'est ce qui separe les deux ordres.
    const source = new FakeSource().prend(FOUGUE).prend(VITALITE);

    expect(passiveRows(source).map((r) => r.name)).toEqual([
      passiveOf(VITALITE).label,
      passiveOf(FOUGUE).label,
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

describe('paintPassives — les emplacements a l ecran', () => {
  let el: HudElements;
  beforeEach(() => {
    el = hudElements();
  });

  /** Le nom et le compte de chaque emplacement rempli, dans l'ordre affiche. */
  const lignes = (): string[] =>
    [...el.passiveList.querySelectorAll<HTMLElement>('.hud-passive')].map((n) => n.title);

  it('etape 13 : aucun cadre tant que rien n est pris, plus de remplissage a vide', () => {
    paintPassives(el.passiveList, []);

    expect(el.passiveList.children).toHaveLength(0);
    expect(lignes()).toEqual([]);
  });

  it('ecrit le nom ET le nombre d exemplaires, le compte visible en coin', () => {
    // ⚠️ **Le nombre est la moitie du message.** Un passif pris quatre fois
    // n'est pas un passif pris une fois : c'est tout le modele Risk of Rain.
    paintPassives(el.passiveList, [
      { name: 'vitalite', kind: 'maxHp', stacks: 4 },
      { name: 'cadence', kind: 'fireRate', stacks: 1 },
    ]);

    expect(lignes()).toEqual(['vitalite ×4', 'cadence ×1']);
    expect(el.passiveList.querySelector('.hud-passive .slot__count')?.textContent).toBe('4');
    expect(el.passiveList.children).toHaveLength(2);
  });

  it('repeint a chaque appel, sans cumuler les emplacements precedents', () => {
    paintPassives(el.passiveList, [{ name: 'vitalite', kind: 'maxHp', stacks: 1 }]);
    paintPassives(el.passiveList, [{ name: 'vitalite', kind: 'maxHp', stacks: 2 }]);

    expect(lignes()).toEqual(['vitalite ×2']);
    expect(el.passiveList.children).toHaveLength(1);
  });

  it('suit passiveRows, sans dupliquer', () => {
    const source = new FakeSource().prend(VITALITE, 2).prend(CADENCE, 5);
    paintPassives(el.passiveList, passiveRows(source));

    expect(lignes().length).toBeLessThanOrEqual(PASSIVES.length);
    expect(lignes()).toEqual([`${passiveOf(VITALITE).label} ×2`, `${passiveOf(CADENCE).label} ×5`]);
  });

  it('etape 13 : la colonne des passifs suit ce qui est possede, sans cadre vide', () => {
    const source = new FakeSource().prend(VITALITE, 1).prend(CADENCE, 1);
    paintPassives(el.passiveList, passiveRows(source));

    expect(el.passiveList.children).toHaveLength(2);
  });
});

describe('paintHud — chaque case du HUD recoit son ecriture', () => {
  let el: HudElements;
  let source: FakeSource;

  beforeEach(() => {
    el = hudElements();
    source = new FakeSource();
  });

  it('ecrit les points de vie du joueur local sur son maximum, et remplit la barre', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.hp.textContent).toBe('73 / 146');
    expect(el.hpFill.style.getPropertyValue('--v')).toBe('0.5');
  });

  it('remplit la barre d experience et compte les abattus', () => {
    source.kills = 1284;
    paintHud(el, INFO, 0, 0, source);
    expect(el.xpFill.style.getPropertyValue('--v')).toBe('0.25');
    // L'XP lisible sur sa jauge, et la jauge est BIEN celle du sous-PV, en bleu.
    expect(el.xpLabel?.textContent).toBe('500 / 2000');
    expect(el.xpFill.classList.contains('bar__fill--xp')).toBe(true);
    expect(el.kills.textContent).toBe(`1${THIN_SPACE}284`);
  });

  it('montre les emplacements du loadout, la dague comprise, puis les vides', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.weapons.children).toHaveLength(WEAPON_SLOTS);
  });

  it('ecrit le niveau', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.level.textContent).toBe('4');
  });

  it('ecrit le chronometre', () => {
    paintHud(el, INFO, 0, 0, source);
    expect(el.timer.textContent).toBe('2:07');
  });

  it('ecrit le compteur de morts tardives — le chiffre de diagnostic du §2', () => {
    paintHud(el, INFO, 12, 0, source);
    expect(el.lateDeaths.textContent).toBe('12');
  });

  it('peint la jauge de Synergie', () => {
    paintHud(el, INFO, 0, SYNERGY_MAX / 2, source);
    expect(el.synergyFill.style.getPropertyValue('--v')).toBe('0.5');
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

    expect(
      [...el.passiveList.querySelectorAll<HTMLElement>('.hud-passive')].map((n) => n.title),
    ).toEqual([`${passiveOf(VITALITE).label} ×4`]);
  });

  it('laisse les emplacements vides quand le joueur n a pris aucun passif', () => {
    paintHud(el, INFO, 0, 0, source);

    expect(el.passiveList.querySelectorAll('.hud-passive')).toHaveLength(0);
  });

  /**
   * ⚠️ **L'or du §5, EN PERMANENCE et pas seulement au moment du vote.** Une
   * cagnotte qu'on ne verrait qu'a l'ouverture du portail se lirait comme un
   * score de fin de manche, pas comme cinq minutes pendant lesquelles rien
   * n'est acquis — c'est cette tension-la que le §5 met en jeu.
   *
   * Le montant est groupe : `1 234 567` se lit d'un coup d'oeil pendant une
   * vague, `1234567` non. Le separateur est l'espace fine insecable, pose par
   * `formatGold` et jamais par `Intl` (voir sa doc).
   */
  it('ecrit la cagnotte non securisee, groupee par milliers', () => {
    source.gold = 1_234_567;
    paintHud(el, INFO, 0, 0, source);

    expect(el.gold.textContent).toBe(`1${THIN_SPACE}234${THIN_SPACE}567`);
  });

  it('ecrit une cagnotte vide comme un zero, jamais comme du vide', () => {
    // Le HUD est visible des le premier snapshot, bien avant le premier boss :
    // une case blanche s'y lirait comme un bug d'affichage.
    source.gold = 0;
    paintHud(el, INFO, 0, 0, source);

    expect(el.gold.textContent).toBe('0');
  });

  /** Tache 24 : le gel de niveau, la dette non gardee de l'etape 3. */
  it('montre le bandeau de gel pendant le gel, et le cache sinon', () => {
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.classList.contains('hidden')).toBe(false);

    paintHud(el, { ...INFO, frozen: false }, 0, 0, source);
    expect(el.freeze.classList.contains('hidden')).toBe(true);
  });

  it('etape 11 : le bandeau de gel dit « Coffre » pendant un coffre, « Niveau superieur » sinon', () => {
    source.draftIsChest = true;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Coffre — pause…');
    source.draftIsChest = false;
    paintHud(el, { ...INFO, frozen: true }, 0, 0, source);
    expect(el.freeze.textContent).toBe('Niveau supérieur — pause…');
  });

  it('etape 11 : le bandeau du porteur suit porteurBannerOn', () => {
    source.porteurBannerOn = true;
    paintHud(el, INFO, 0, 0, source);
    expect(el.porteur?.classList.contains('hidden')).toBe(false);
    expect(el.porteur?.textContent?.trim()).toBe('Un porteur de coffre est apparu !');
    source.porteurBannerOn = false;
    paintHud(el, INFO, 0, 0, source);
    expect(el.porteur?.classList.contains('hidden')).toBe(true);
  });

  describe('etape 13 : la barre de bouclier', () => {
    /**
     * ⚠️ Vigilance 5 : elle se peint depuis le SNAPSHOT seul (`HudInfo`,
     * derive de `RenderState.players`), jamais depuis le miroir d'inventaire
     * (`HudSource.loadoutOf`). Un client qui ignore l'inventaire d'un joueur
     * (arrive en cours de partie) doit quand meme afficher la bonne barre —
     * c'est pour ca que ce test ne donne au `FakeSource` AUCUN passif.
     */
    it('se peint sans lire le miroir d inventaire', () => {
      paintHud(el, { ...INFO, shield: 30, shieldPool: 60 }, 0, 0, source);

      expect(el.shieldFill.style.getPropertyValue('--v')).toBe('0.5');
      expect(el.shield.classList.contains('hidden')).toBe(false);
    });

    it('reste masquee sans bouclier', () => {
      paintHud(el, { ...INFO, shield: 0, shieldPool: 0 }, 0, 0, source);

      expect(el.shield.classList.contains('hidden')).toBe(true);
    });
  });
});

describe('paintAbility — la case du verbe', () => {
  const cases = (): AbilityElements => ({
    box: document.createElement('div'),
    icon: document.createElement('img'),
    cooldown: document.createElement('span'),
    name: document.createElement('span'),
  });

  it('cachee sans classe : un joueur arrive en cours de partie n a pas de verbe', () => {
    const el = cases();
    paintAbility(el, null, 0);
    expect(el.box.classList.contains('hidden')).toBe(true);
  });

  it('prete : le nom de la classe, et aucune recharge affichee', () => {
    const el = cases();
    paintAbility(el, 3, 0);
    expect(el.box.classList.contains('hidden')).toBe(false);
    expect(el.name.textContent).toBe('Relais');
    expect(el.box.dataset.ready).toBe('true');
    expect(el.cooldown.textContent).toBe('');
  });

  it('en recharge : les secondes restantes, arrondies au-dessus', () => {
    const el = cases();
    paintAbility(el, 1, TICK_HZ * 2 + 1);
    expect(el.box.dataset.ready).toBe('false');
    expect(el.cooldown.textContent).toBe('3');
  });

  it('une icone par verbe, distinctes', () => {
    const vues = new Set<string>();
    for (const id of [0, 1, 2, 3]) {
      const el = cases();
      paintAbility(el, id, 0);
      vues.add(el.icon.getAttribute('src') ?? '');
    }
    expect(vues.size).toBe(4);
  });
});
