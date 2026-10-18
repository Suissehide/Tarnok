import { classOf, type VerbKind } from '@shared/classes';
import { SYNERGY_MAX, TICK_HZ, WEAPON_SLOTS } from '@shared/constants';
import type { Loadout } from '@shared/loadout';
import { PASSIVES, type PassiveKind } from '@shared/passives';
import { weaponOf } from '@shared/weapons';

import type { HudInfo } from '../render/stage';
import { elementBadge, elementLabel } from './element-icons';
import { avatar, bonusIcon, ICON_WEAPON, icon, slot } from './icons';
import { formatGold } from './portal';

/**
 * Le HUD, en DOM et pas en Pixi : c'est de l'interface, pas du monde.
 *
 * ⚠️ **Dans un module a part, et pas dans `main.ts`.** `main.ts` fait
 * `await stage.init()` au niveau module : il n'est pas importable en test, et
 * tout ce qu'on y ecrit echappe a la suite. Ici, la regle vit dans des
 * fonctions testables sous jsdom ; il ne reste dans `main.ts` que l'appel.
 */

/**
 * Part de la jauge de Synergie effectivement remplie, dans `[0, 1]`.
 *
 * ⚠️ **Borne HAUTE indispensable** : le serveur plafonne a `SYNERGY_MAX`, mais
 * un serveur plus recent (plafond releve) ferait deborder la barre. La borne
 * basse ne peut pas etre franchie : le total est un `u16` sur le fil.
 */
export function synergyRatio(synergy: number): number {
  return Math.min(1, Math.max(0, synergy / SYNERGY_MAX));
}

/**
 * Peint la jauge : la largeur du remplissage, et le compte en clair. Un joueur
 * qui voit `3 / 20` bouger d'un cran juste apres un flash blanc fait le lien
 * avec la reaction ; une barre qui glisse de trois pixels, non.
 */
export function paintSynergy(fill: HTMLElement, label: HTMLElement, synergy: number): void {
  // `--v` : la jauge du kit (`.bar__fill`) en tire sa largeur, retraits compris.
  fill.style.setProperty('--v', `${synergyRatio(synergy)}`);
  label.textContent = `${synergy} / ${SYNERGY_MAX}`;
}

/**
 * Une ligne de la colonne des passifs : ce qu'on a pris, et **combien de
 * fois** — rien ne monte de niveau, chaque carte s'empile et ajoute une fois
 * sa `magnitude`.
 */
export interface PassiveRow {
  /** L'etiquette affichee (`Passive.label`, accentuee) — jamais l'identifiant `Passive.name`. */
  name: string;
  /** La cle de bonus du passif : c'est elle qui choisit l'icone (`ui/icons.ts`). */
  kind: PassiveKind;
  stacks: number;
}

/**
 * Ce que le HUD lit du client. Interface structurelle plutot que `GameClient`,
 * comme `FrameClient` et `DraftSource` : le test en fabrique un double sans
 * ouvrir de WebSocket.
 *
 * Les inventaires viennent du miroir `GameClient.loadoutOf`, reconstitue des
 * `DRAFT_RESULT` recus : rien a ajouter au protocole.
 */
export interface HudSource {
  readonly localId: number | null;
  readonly localClassId: number | null;
  /**
   * L'or NON SECURISE de l'equipe, tel que le dernier snapshot le porte.
   *
   * ⚠️ **Lu sur le client, pas sur `RenderState`** : `RenderState` est ce que
   * la PREDICTION produit, et l'or n'est ni predit ni interpole.
   */
  readonly gold: number;
  /** PV max du joueur local : base, cartes de vitalite et achats du compte. */
  readonly localMaxHp: number;
  /** Ennemis abattus depuis le debut de la run, tels que `DEATHS` les a annonces. */
  readonly kills: number;
  /** L'etalage en cours est un coffre : le bandeau de gel le dit. Absent : non. */
  readonly draftIsChest?: boolean;
  /** Le bandeau « un porteur est apparu » est-il allume ? Absent : non. */
  readonly porteurBannerOn?: boolean;
  loadoutOf(playerId: number): Loadout;
}

/**
 * Les passifs du joueur LOCAL, dans l'ordre du catalogue — stable, donc la
 * colonne se relit d'un coup d'oeil au lieu de se reordonner a chaque carte.
 *
 * ⚠️ `localId` nul rend une colonne vide : `loadoutOf` cree l'entree
 * manquante a la volee, et un identifiant invente garnirait la `Map` du client
 * d'un joueur qui n'existe pas.
 */
export function passiveRows(source: HudSource): PassiveRow[] {
  const id = source.localId;
  if (id === null) {
    return [];
  }
  const loadout = source.loadoutOf(id);
  const rows: PassiveRow[] = [];
  for (const passive of PASSIVES) {
    const stacks = loadout.stacksOf(passive.id);
    if (stacks > 0) {
      rows.push({ name: passive.label, kind: passive.kind, stacks });
    }
  }
  return rows;
}

/**
 * Peint les emplacements de passifs : exactement un cadre par passif POSSEDE
 * (les passifs n'ont pas de borne, donc pas de cadre vide), avec son icone et
 * son compte d'empilements — meme a un seul exemplaire : « 1 » puis « 2 » dit
 * qu'on vient d'empiler. Nom et compte complets dans le `title`.
 */
export function paintPassives(list: HTMLElement, rows: readonly PassiveRow[]): void {
  const cells = rows.map((row) =>
    slot('hud-passive', {
      src: bonusIcon(row.kind),
      count: row.stacks,
      title: `${row.name} ×${row.stacks}`,
    }),
  );
  list.replaceChildren(...cells);
}

/**
 * Peint les `WEAPON_SLOTS` emplacements d'armes : celles du `Loadout` dans
 * l'ordre du draft, chacune avec l'icone de son element, puis des cadres
 * vides.
 */
export function paintWeapons(list: HTMLElement, loadout: Loadout | null): void {
  const ids = loadout ? [...loadout.weaponIds] : [];
  const cells = ids.map((id) =>
    slot(
      '',
      {
        src: ICON_WEAPON,
        count: loadout?.stacksOfWeapon(id) ?? 0,
        title: `${weaponOf(id).name} — ${elementLabel(weaponOf(id).element)}`,
      },
      'paperx',
    ),
  );
  for (const [i, id] of ids.entries()) {
    cells[i]?.append(elementBadge(weaponOf(id).element, 22));
  }
  while (cells.length < WEAPON_SLOTS) {
    cells.push(slot('', null, 'paperx'));
  }
  list.replaceChildren(...cells);
}

/**
 * Les elements du HUD, tels que `index.html` les nomme. Passes en argument
 * plutot que cherches ici : le test peut donner le vrai `index.html` monte
 * sous jsdom, et verifier le CABLAGE.
 */
export interface HudElements {
  hp: HTMLElement;
  /** Le remplissage de la barre de PV (`.bar__fill`). */
  hpFill: HTMLElement;
  /** Le conteneur masquable de la barre de bouclier, posee sur celle des PV. */
  shield: HTMLElement;
  /** Le remplissage de la barre de bouclier. */
  shieldFill: HTMLElement;
  /** Le remplissage de la barre d'experience, en haut de l'ecran. */
  xpFill: HTMLElement;
  /** `xp / seuil` sur la jauge d'XP. Optionnel : les anciens HUD de test n'en ont pas. */
  xpLabel?: HTMLElement;
  portrait: HTMLImageElement;
  kills: HTMLElement;
  weapons: HTMLElement;
  level: HTMLElement;
  timer: HTMLElement;
  lateDeaths: HTMLElement;
  synergyFill: HTMLElement;
  synergyLabel: HTMLElement;
  /** La cagnotte non securisee, visible en permanence. */
  gold: HTMLElement;
  freeze: HTMLElement;
  /** Le bandeau du porteur de coffre. Optionnel : les anciens HUD de test n'en ont pas. */
  porteur?: HTMLElement;
  /** Les emplacements de passifs. */
  passiveList: HTMLElement;
}

/**
 * Ecrit tout le HUD a partir du contenu pur calcule par `hudInfo`. Hors de
 * `main.ts` pour qu'une mutation qui retire une seule de ces lignes rougisse.
 *
 * `lateDeaths` et `synergy` ne sont pas dans `HudInfo` : le premier vient de
 * `GameClient.lateDeaths` (compteur de diagnostic), le second de
 * `RenderState.synergy` (donnee d'equipe du snapshot, comme l'xp).
 *
 * ⚠️ **`source` est le client lui-meme, pas une liste deja calculee** : sinon
 * l'appel `passiveRows(client)` retournerait dans `main.ts`, ou rien ne le
 * garde.
 */
export function paintHud(
  el: HudElements,
  info: HudInfo,
  lateDeaths: number,
  synergy: number,
  source: HudSource,
): void {
  const maxHp = Math.max(1, source.localMaxHp);
  el.hp.textContent = `${Math.ceil(info.hp)} / ${maxHp}`;
  el.hpFill.style.setProperty('--v', `${Math.min(1, Math.max(0, info.hp / maxHp))}`);
  // La reserve de bouclier (Transcendance), posee par-dessus les PV.
  //
  // ⚠️ **Lue dans `info` (le SNAPSHOT), jamais dans `source`** : un client
  // rejoint en cours de partie n'a pas le `Loadout` des autres dans le miroir,
  // mais voit leur bouclier sur le fil (`PlayerSnapshot.shield`).
  el.shield.classList.toggle('hidden', info.shield <= 0);
  el.shieldFill.style.setProperty(
    '--v',
    `${info.shieldPool > 0 ? Math.min(1, Math.max(0, info.shield / info.shieldPool)) : 0}`,
  );
  el.xpFill.style.setProperty('--v', `${info.xpRatio}`);
  if (el.xpLabel) {
    el.xpLabel.textContent = `${Math.floor(info.xp)} / ${info.xpNeeded}`;
  }
  el.level.textContent = `${info.level}`;
  el.timer.textContent = info.timer;
  el.kills.textContent = formatGold(source.kills);
  const id = source.localId;
  const portrait = id === null ? '' : avatar(id, source.localClassId ?? 0);
  if (el.portrait.getAttribute('src') !== portrait) {
    el.portrait.src = portrait;
  }
  el.lateDeaths.textContent = `${lateDeaths}`;
  paintSynergy(el.synergyFill, el.synergyLabel, synergy);
  // La cagnotte NON SECURISEE, en permanence et pas seulement au vote : c'est
  // un enjeu qui se vit pendant tout le palier. `formatGold` est celui du
  // portail, importe plutot que recopie.
  el.gold.textContent = formatGold(source.gold);
  paintPassives(el.passiveList, passiveRows(source));
  paintWeapons(el.weapons, id === null ? null : source.loadoutOf(id));
  // Seule indication du gel avant l'etalage de cartes : sans elle, la pause
  // se lit comme un plantage.
  el.freeze.classList.toggle('hidden', !info.frozen);
  // Un coffre gele comme un niveau, mais il le dit.
  el.freeze.textContent = source.draftIsChest ? 'Coffre — pause…' : 'Niveau supérieur — pause…';
  el.porteur?.classList.toggle('hidden', source.porteurBannerOn !== true);
}

/** L'icone du verbe de chaque classe : un choix d'affichage, comme `BONUS_ICONS`. */
const VERB_ICONS: Readonly<Record<VerbKind, number>> = {
  amorce: 7,
  rempart: 6,
  appat: 4,
  relais: 8,
};

/** La case du verbe, cherchee une fois par `main.ts`. */
export interface AbilityElements {
  box: HTMLElement;
  icon: HTMLImageElement;
  cooldown: HTMLElement;
  name: HTMLElement;
}

/**
 * Peint la case du verbe : l'icone de la classe, son nom, et la recharge en
 * secondes tant qu'elle court (`data-ready="false"`, icone assombrie par la
 * CSS). Cachee sans classe — un joueur arrive en cours de partie n'a pas de
 * verbe.
 *
 * ⚠️ **La recharge affichee est celle du MIROIR** (`GameClient`, derivee de
 * la derniere annonce) : le client ne decide de rien, il montre quand le salon
 * acceptera de nouveau.
 */
export function paintAbility(
  el: AbilityElements,
  classId: number | null,
  cooldownTicks: number,
): void {
  const classe = classId === null ? undefined : classOf(classId);
  el.box.classList.toggle('hidden', !classe);
  if (!classe) {
    return;
  }
  const src = icon(VERB_ICONS[classe.verb]);
  if (el.icon.getAttribute('src') !== src) {
    el.icon.src = src;
  }
  el.name.textContent = classe.label;
  const pret = cooldownTicks <= 0;
  el.box.dataset.ready = pret ? 'true' : 'false';
  el.cooldown.textContent = pret ? '' : `${Math.ceil(cooldownTicks / TICK_HZ)}`;
}
