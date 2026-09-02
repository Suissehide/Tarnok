import { type BossCharge, makeBossCharge } from '@shared/boss';
import { entityIdOf } from '@shared/horde';
import { Container, type Particle, type ParticleContainer, Texture, TextureSource } from 'pixi.js';
import { describe, expect, it } from 'vitest';

import {
  CHARGE_ALPHA,
  CHARGE_ARROW_ALPHA_RATIO,
  CHARGE_ARROW_SPACING_PX,
  CHARGE_ARROW_TEXTURE_SIZE,
  CHARGE_ARROW_WIDTH_RATIO,
  CHARGE_FILL_RATIO,
  CHARGE_RIM_INNER,
  CHARGE_RIM_PEAK,
  CHARGE_TEXTURE_SIZE,
  ChargeRenderer,
  chargeAlphaAt,
  chargeArrows,
  chargeQuad,
} from './charge-renderer';

/**
 * Le rectangle d'annonce de la charge du boss (etape 6a, tache 5 bis).
 *
 * ⚠️ **Ce calque ne fait PAS tourner le boss, et aucun test ne doit lui
 * demander de le faire.** Decision de l'auteur : *« pas besoin de faire tourner
 * le boss, l'animation d'attaque le fait deja tourner »*. La rotation qu'on
 * teste ici est celle du COULOIR — l'orientation du rectangle — jamais celle du
 * sprite.
 *
 * Deux choses a garder, independantes : ce que `chargeQuad` DIT (ou, comment,
 * a quelle opacite) et ce que `draw` POSE vraiment sur le quad.
 */

const BOSS_ID = entityIdOf(7, 0);

/** Une charge vers l'est, annoncee au tick 100 depuis (1000, 2000). */
function charge(): BossCharge {
  return makeBossCharge(BOSS_ID, 1000, 2000, 5000, 2000, 100);
}

describe('chargeAlphaAt — l opacite MONTE pendant le chargement', () => {
  it('ne dessine rien avant l annonce ni apres la fin', () => {
    const c = charge();
    expect(chargeAlphaAt(c, c.windupTick - 1)).toBe(0);
    expect(chargeAlphaAt(c, c.endTick + 1)).toBe(0);
  });

  /**
   * ⚠️ **La montee EST le compte a rebours.** C'est la seule chose que le
   * joueur lise pour savoir combien de temps il lui reste : une opacite
   * constante annoncerait qu'il se passe quelque chose sans dire quand.
   */
  it('monte strictement du tick d annonce au tick de depart', () => {
    const c = charge();
    let precedent = -1;
    for (let t = c.windupTick; t <= c.startTick; t++) {
      const a = chargeAlphaAt(c, t);
      expect(a, `tick ${t}`).toBeGreaterThan(precedent);
      precedent = a;
    }
    expect(precedent).toBe(CHARGE_ALPHA);
  });

  it('part de zero et atteint exactement CHARGE_ALPHA au depart', () => {
    const c = charge();
    expect(chargeAlphaAt(c, c.windupTick)).toBe(0);
    expect(chargeAlphaAt(c, c.startTick)).toBe(CHARGE_ALPHA);
  });

  it('reste plein pendant toute la traversee', () => {
    const c = charge();
    for (let t = c.startTick; t <= c.endTick; t++) {
      expect(chargeAlphaAt(c, t), `tick ${t}`).toBe(CHARGE_ALPHA);
    }
  });
});

describe('chargeQuad — ou le couloir se pose, et quand il ne se pose pas', () => {
  it('rend null quand aucune charge n est en cours', () => {
    expect(chargeQuad(null, 100)).toBeNull();
  });

  it('rend null hors de la fenetre de la charge', () => {
    const c = charge();
    expect(chargeQuad(c, c.windupTick - 1)).toBeNull();
    expect(chargeQuad(c, c.endTick + 1)).toBeNull();
  });

  /**
   * ⚠️ **Le rectangle part de l'ORIGINE annoncee et n'en bouge plus.** C'est le
   * boss qui le traverse : un couloir qui suivrait le boss ne dirait plus rien
   * de ce qui reste a parcourir.
   */
  it('se pose a l origine du couloir, jamais sur la position courante du boss', () => {
    const c = charge();
    const debut = chargeQuad(c, c.windupTick + 5);
    const fin = chargeQuad(c, c.endTick);

    expect(debut?.x).toBe(c.x);
    expect(debut?.y).toBe(c.y);
    expect(fin?.x).toBe(c.x);
    expect(fin?.y).toBe(c.y);
  });

  it('oriente le rectangle dans la direction de la charge', () => {
    const est = chargeQuad(makeBossCharge(BOSS_ID, 0, 0, 100, 0, 0), 5);
    const sud = chargeQuad(makeBossCharge(BOSS_ID, 0, 0, 0, 100, 0), 5);

    expect(est?.rotation).toBeCloseTo(0, 4);
    expect(sud?.rotation).toBeCloseTo(Math.PI / 2, 4);
  });

  it('porte la longueur et la largeur de la charge, pas des constantes a lui', () => {
    const c = charge();
    const quad = chargeQuad(c, c.startTick);

    expect(quad?.length).toBe(c.length);
    expect(quad?.width).toBe(c.width);
  });
});

/**
 * **Le corps de `draw`, atteint.** Sans `adoptTexture`, `draw` retournerait a
 * son premier garde dans toute la suite et tout son corps pourrait etre retire
 * sans qu'une assertion ne bouge — c'est litteralement ce que `ZoneRenderer.draw`
 * a fait pendant 237 tests verts dans ce depot.
 */
function quadsDessines(c: BossCharge | null, tick: number): Particle[] {
  const monte = calque();
  monte.renderer.draw(c, tick);
  return [...(monte.couloir.particleChildren as Particle[])];
}

/**
 * Le calque monte, ses DEUX conteneurs sous la main.
 *
 * ⚠️ **Deux textures DISTINCTES, jamais la meme passee deux fois.** Un decor
 * qui donnerait la texture du couloir aux fleches rendrait indistinguable un
 * `adoptTexture` qui ne cuirait qu'un seul dessin — et un `ParticleContainer`
 * ne porte qu'une texture source, donc c'est precisement ce que la separation
 * des deux calques garde.
 */
function calque(): {
  renderer: ChargeRenderer;
  couloir: ParticleContainer;
  fleches: ParticleContainer;
} {
  const renderer = new ChargeRenderer();
  renderer.adoptTexture(
    new Texture({ source: new TextureSource({ width: 16, height: 16 }) }),
    new Texture({ source: new TextureSource({ width: 8, height: 8 }) }),
  );
  const world = new Container();
  renderer.attach(world);
  // ⚠️ **Le calque du couloir n'ajoute qu'UN enfant au monde** : le couloir et
  // ses fleches sont deux `ParticleContainer` (un conteneur ne porte qu'une
  // texture source) groupes sous un noeud, pour que le « neuf calques » de
  // `stage.test.ts` continue de nommer ce qu'il compte.
  const racine = world.children[0] as Container;
  expect(world.children).toHaveLength(1);
  return {
    renderer,
    couloir: racine.children[0] as ParticleContainer,
    fleches: racine.children[1] as ParticleContainer,
  };
}

describe('ChargeRenderer.draw — ce que le quad porte vraiment', () => {
  it('ne dessine rien sans charge', () => {
    expect(quadsDessines(null, 100)).toHaveLength(0);
  });

  it('ne dessine rien une fois la charge finie', () => {
    const c = charge();
    expect(quadsDessines(c, c.endTick + 1)).toHaveLength(0);
  });

  it('dessine un seul quad pendant la charge', () => {
    const c = charge();
    expect(quadsDessines(c, c.startTick)).toHaveLength(1);
  });

  it('pose le quad a l origine du couloir, ancre a gauche pour partir de la', () => {
    const c = charge();
    const [quad] = quadsDessines(c, c.startTick);

    expect(quad?.anchorX).toBe(0);
    expect(quad?.anchorY).toBe(0.5);
    expect(quad?.x).toBe(c.x);
    expect(quad?.y).toBe(c.y);
  });

  /**
   * ⚠️ **L'echelle, pas la texture.** `CHARGE_TEXTURE_SIZE` (64) ne vaut ni la
   * longueur (900) ni la largeur (192) : une mutation qui poserait `scaleX = 1`
   * — le couloir ne suit plus sa longueur — rougit donc ici. C'est le meme
   * piege que `ZONE_TEXTURE_DIAMETER` a paye a l'etape 5a.
   */
  it('etire le quad a la longueur ET a la largeur du couloir', () => {
    const c = charge();
    const [quad] = quadsDessines(c, c.startTick);

    expect(quad?.scaleX).toBeCloseTo(c.length / CHARGE_TEXTURE_SIZE, 6);
    expect(quad?.scaleY).toBeCloseTo(c.width / CHARGE_TEXTURE_SIZE, 6);
  });

  it('oriente le quad dans la direction de la charge', () => {
    const c = makeBossCharge(BOSS_ID, 0, 0, 0, 100, 0);
    const [quad] = quadsDessines(c, c.startTick);

    expect(quad?.rotation).toBeCloseTo(Math.PI / 2, 4);
  });

  /**
   * **Les deux moities de « l'opacite monte ».** Le plein seul passerait avec
   * une opacite constante ; le debut seul passerait avec une opacite toujours
   * nulle.
   */
  it('fait monter l opacite du quad pendant le chargement', () => {
    const c = charge();
    const tot = quadsDessines(c, c.windupTick + 5)[0]?.alpha ?? 0;
    const tard = quadsDessines(c, c.startTick - 1)[0]?.alpha ?? 0;
    const plein = quadsDessines(c, c.startTick + 1)[0]?.alpha ?? 0;

    expect(tot).toBeGreaterThan(0);
    expect(tard).toBeGreaterThan(tot);
    expect(plein).toBe(CHARGE_ALPHA);
  });

  /**
   * Le calque est REUTILISE d'une image a l'autre : le quad est construit une
   * fois. Une image sans charge doit vider la liste, pas laisser le couloir de
   * l'image precedente.
   */
  it('efface le couloir a l image suivante quand la charge est finie', () => {
    const { renderer, couloir: container } = calque();
    const c = charge();

    renderer.draw(c, c.startTick);
    expect(container.particleChildren).toHaveLength(1);

    renderer.draw(c, c.endTick + 1);
    expect(container.particleChildren).toHaveLength(0);
  });

  it('est additif, comme les zones : le couloir s ajoute au terrain qu il couvre', () => {
    expect(new ChargeRenderer().blendMode).toBe('add');
  });
});

/**
 * ⚠️ **Le bord d'un couloir est une REGLE DE JEU** : c'est lui qui dit ou il
 * faut etre pour ne pas etre touche. Un aplat uniforme ne dit ni ou il commence
 * ni ou il finit — meme raisonnement, mot pour mot, que `ZONE_FILL_RATIO`.
 */
describe('le couloir se lit : un lisere, pas un aplat', () => {
  it('garde l interieur franchement plus discret que le bord', () => {
    expect(CHARGE_FILL_RATIO).toBeGreaterThan(0);
    expect(CHARGE_FILL_RATIO).toBeLessThan(0.5);
  });

  /**
   * *« Legerement rouge »* (§4 de la spec) : le §6.6 de l'orientation est
   * categorique sur le fait que l'etat persistant reste DISCRET, et ce
   * rectangle est le plus grand aplat du jeu.
   */
  it('reste discret : le couloir ne blanchit pas l ecran', () => {
    expect(CHARGE_ALPHA).toBeGreaterThan(0);
    expect(CHARGE_ALPHA).toBeLessThan(0.5);
  });

  /**
   * ⚠️ **Le lisere est un TRAIT, pas un second aplat** (etape 6a, tache 13) —
   * *« plus fins les bords de la zone rouge »*. Il occupait 14 % de la
   * demi-largeur de chaque cote, soit 27 px sur 96 : a cette epaisseur, le
   * couloir entier paraissait plein et la frontiere ne se lisait plus.
   *
   * Les deux moities : assez MINCE pour etre un trait, et non NUL — un lisere
   * disparu rendrait le couloir uniforme, ce que `CHARGE_FILL_RATIO` existe
   * precisement pour eviter.
   */
  it('garde un lisere mince, et un lisere quand meme', () => {
    const epaisseur = 1 - CHARGE_RIM_INNER;
    expect(epaisseur).toBeGreaterThan(0);
    expect(epaisseur).toBeLessThan(0.1);
    // Le degrade existe encore : a egalite, le lisere serait une marche franche
    // et crenelerait des que le couloir tourne.
    expect(CHARGE_RIM_PEAK).toBeGreaterThan(CHARGE_RIM_INNER);
    expect(CHARGE_RIM_PEAK).toBeLessThan(1);
  });
});

/**
 * Les fleches du couloir (etape 6a, tache 13) — *« fais des fleches qui
 * indiquent la direction au centre de la zone rouge »*.
 *
 * ⚠️ **Un couloir sans direction se lit comme une zone.** Le rectangle dit
 * *ou*, pas *vers ou*, et ses deux bouts se ressemblent : c'est la seule
 * information de la charge qu'aucun pixel ne portait.
 */
describe('chargeArrows — le couloir dit son sens', () => {
  it('ne pose aucune fleche quand il n y a pas de couloir', () => {
    const c = charge();
    expect(chargeArrows(null, 100)).toHaveLength(0);
    expect(chargeArrows(c, c.endTick + 1)).toHaveLength(0);
  });

  /**
   * ⚠️ **Le compte se DERIVE de la longueur, il n'est pas ecrit.** Un « cinq
   * fleches » en dur mentirait au premier couloir d'une autre longueur — et
   * l'etape 6b en promet d'autres. Le test compare a la derivation, pas a 5.
   */
  it('espace les fleches sur toute la longueur, au lieu d en poser un nombre fixe', () => {
    const c = charge();
    const attendu = Math.max(1, Math.round(c.length / CHARGE_ARROW_SPACING_PX));
    expect(chargeArrows(c, c.startTick)).toHaveLength(attendu);
    // Non-vacuite : le couloir du troll en porte plusieurs, donc « une seule
    // fleche » et « une par intervalle » ne se confondent pas ici.
    expect(attendu).toBeGreaterThan(1);
  });

  it('en pose une seule, et pas zero, sur un couloir plus court que l espacement', () => {
    const c = { ...charge(), length: CHARGE_ARROW_SPACING_PX / 4 };
    expect(chargeArrows(c, c.startTick)).toHaveLength(1);
  });

  /**
   * **Le coeur de la tache.** Les fleches doivent etre DANS le couloir, sur son
   * axe, et progresser dans le sens de la charge — une fleche posee a l'origine
   * ou au-dela de l'extremite ne dirait plus rien du couloir.
   */
  it('les aligne sur l axe du couloir, dans le sens de la charge, sans deborder', () => {
    const c = charge(); // vers l'est depuis (1000, 2000)
    const fleches = chargeArrows(c, c.startTick);

    for (const f of fleches) {
      expect(f.y).toBeCloseTo(c.y, 6);
      expect(f.x).toBeGreaterThan(c.x);
      expect(f.x).toBeLessThan(c.x + c.length);
      expect(f.rotation).toBeCloseTo(Math.atan2(c.dirY, c.dirX), 6);
    }
    // Strictement croissantes : elles decrivent une progression, pas un tas.
    for (let i = 1; i < fleches.length; i++) {
      expect(fleches[i]?.x ?? 0).toBeGreaterThan(fleches[i - 1]?.x ?? 0);
    }
  });

  it('tourne avec le couloir, pas seulement vers l est', () => {
    const c = makeBossCharge(BOSS_ID, 0, 0, 0, 100, 0); // plein sud
    const fleches = chargeArrows(c, c.startTick);

    expect(fleches.length).toBeGreaterThan(0);
    for (const f of fleches) {
      expect(f.rotation).toBeCloseTo(Math.PI / 2, 4);
      expect(f.x).toBeCloseTo(c.x, 6);
      expect(f.y).toBeGreaterThan(c.y);
    }
  });

  /**
   * ⚠️ **Une taille DERIVEE de la largeur du couloir**, jamais un nombre
   * absolu : une fleche de taille fixe deborderait du premier couloir plus
   * etroit qu'elle.
   */
  it('taille les fleches sur la largeur du couloir, sans la remplir', () => {
    const c = charge();
    const [f] = chargeArrows(c, c.startTick);

    expect(f?.size).toBeCloseTo(c.width * CHARGE_ARROW_WIDTH_RATIO, 6);
    expect(f?.size).toBeLessThan(c.width);
  });

  /**
   * **Les deux moities du compte a rebours.** Les fleches montent avec le
   * couloir — une opacite fixe crierait « imminent » des la premiere image.
   */
  it('fait monter leur opacite comme celle du couloir, et la borne a 1', () => {
    const c = charge();
    const tot = chargeArrows(c, c.windupTick + 5)[0]?.alpha ?? 0;
    const tard = chargeArrows(c, c.startTick - 1)[0]?.alpha ?? 0;
    const plein = chargeArrows(c, c.startTick + 1)[0]?.alpha ?? 0;

    expect(tot).toBeGreaterThan(0);
    expect(tard).toBeGreaterThan(tot);
    // Plus lisibles que l'aplat sur lequel elles se posent, mais jamais opaques.
    expect(plein).toBeCloseTo(Math.min(1, CHARGE_ALPHA * CHARGE_ARROW_ALPHA_RATIO), 6);
    expect(plein).toBeGreaterThan(CHARGE_ALPHA);
    expect(plein).toBeLessThanOrEqual(1);
  });
});

describe('ChargeRenderer.draw — les fleches posees sur leur propre calque', () => {
  it('ne pose aucune fleche sans charge, et les efface a la fin', () => {
    const { renderer, fleches } = calque();
    const c = charge();

    renderer.draw(null, 100);
    expect(fleches.particleChildren).toHaveLength(0);

    renderer.draw(c, c.startTick);
    expect(fleches.particleChildren.length).toBeGreaterThan(0);

    renderer.draw(c, c.endTick + 1);
    expect(fleches.particleChildren).toHaveLength(0);
  });

  it('en pose autant que la mise en page en annonce, et aux memes endroits', () => {
    const { renderer, fleches } = calque();
    const c = charge();
    renderer.draw(c, c.startTick);

    const attendues = chargeArrows(c, c.startTick);
    const posees = [...(fleches.particleChildren as Particle[])];
    expect(posees).toHaveLength(attendues.length);
    for (let i = 0; i < attendues.length; i++) {
      expect(posees[i]?.x).toBeCloseTo(attendues[i]?.x ?? 0, 4);
      expect(posees[i]?.y).toBeCloseTo(attendues[i]?.y ?? 0, 4);
      expect(posees[i]?.rotation).toBeCloseTo(attendues[i]?.rotation ?? 0, 4);
      expect(posees[i]?.alpha).toBeCloseTo(attendues[i]?.alpha ?? 0, 4);
    }
  });

  /**
   * ⚠️ **L'echelle, pas la texture** — le piege des taches 13 et 15 de l'etape
   * 5a. `CHARGE_ARROW_TEXTURE_SIZE` (32) ne vaut pas la taille affichee (96 px
   * sur le couloir du troll), donc une mutation qui poserait `scaleX = 1`
   * rougit ici.
   */
  it('etire chaque fleche depuis sa texture, qui n a pas sa taille affichee', () => {
    const { renderer, fleches } = calque();
    const c = charge();
    renderer.draw(c, c.startTick);

    const taille = c.width * CHARGE_ARROW_WIDTH_RATIO;
    expect(taille).not.toBe(CHARGE_ARROW_TEXTURE_SIZE);
    const [f] = fleches.particleChildren as Particle[];
    expect(f?.scaleX).toBeCloseTo(taille / CHARGE_ARROW_TEXTURE_SIZE, 6);
    expect(f?.scaleY).toBeCloseTo(taille / CHARGE_ARROW_TEXTURE_SIZE, 6);
    // Centrees sur leur point, contrairement au couloir qui PART du sien.
    expect(f?.anchorX).toBe(0.5);
    expect(f?.anchorY).toBe(0.5);
  });

  it('agrandit son reservoir quand un couloir plus long en demande plus', () => {
    const { renderer, fleches } = calque();
    const court = { ...charge(), length: CHARGE_ARROW_SPACING_PX };
    const long = { ...charge(), length: CHARGE_ARROW_SPACING_PX * 9 };

    renderer.draw(court, court.startTick);
    expect(fleches.particleChildren).toHaveLength(1);
    renderer.draw(long, long.startTick);
    expect(fleches.particleChildren).toHaveLength(9);
  });

  it('est additif, comme le couloir qu il annote', () => {
    const { fleches } = calque();
    expect(fleches.blendMode).toBe('add');
  });
});
